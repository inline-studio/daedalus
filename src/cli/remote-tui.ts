import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  type RemoteProfile,
  type RemoteSession,
  createSession,
  consumeSse,
  startExecutor,
  fetchers,
  sendMessage,
  abortTurn,
} from "./remote-shared.js";
import { LineEditor, Screen, boxify, visibleLength, DIM, RESET, type Key } from "./tui.js";
import { runDashboard, agentsView, skillsView, cronsView, type DashboardView } from "./dashboard.js";

// The `dae remote` terminal interface — a persistent, full-duplex terminal app in the
// Claude-Code/Hermes-CLI shape: streaming scrollback, a live status line, slash
// commands, Esc-to-stop, and the executor's confirmation prompts inline. Plain
// line-mode (remote-client.ts) remains for --plain / pipes / no-TTY.

const HISTORY_FILE = path.join(os.homedir(), ".daedalus", "remote-history");

const TEAL = "\x1b[36m";

function cliVersion(): string {
  try {
    const req = createRequire(import.meta.url);
    return (req("../../package.json") as { version: string }).version;
  } catch {
    return "?";
  }
}

// Two-row Unicode block font (same face as the web UI's empty-chat splash) for the
// boot banner. Unknown characters abort the art — the caller falls back to plain text.
const BLOCK_FONT: Record<string, [string, string]> = {
  A: ["▄▀█", "█▀█"], B: ["█▀▄", "█▄█"], C: ["█▀▀", "█▄▄"], D: ["█▀▄", "█▄▀"],
  E: ["█▀▀", "██▄"], F: ["█▀▀", "█  "], G: ["█▀▀", "█▄█"], H: ["█ █", "█▀█"],
  I: ["█", "█"], J: ["  █", "█▄█"], K: ["█▄▀", "█ █"], L: ["█  ", "█▄▄"],
  M: ["█▀▄▀█", "█ ▀ █"], N: ["█▄ █", "█ ▀█"], O: ["█▀█", "█▄█"], P: ["█▀█", "█▀▀"],
  Q: ["█▀█", "█▄▀"], R: ["█▀█", "█▀▄"], S: ["█▀", "▄█"], T: ["▀█▀", " █ "],
  U: ["█ █", "█▄█"], V: ["█ █", "▀▄▀"], W: ["█ █ █", "▀▄▀▄▀"], X: ["▀▄▀", "▄▀▄"],
  Y: ["█ █", " █ "], Z: ["▀▀█", "█▄▄"], " ": ["  ", "  "],
};
export function blockArt(name: string): [string, string] | null {
  const top: string[] = [];
  const bottom: string[] = [];
  for (const ch of name) {
    const g = BLOCK_FONT[ch];
    if (!g) return null;
    top.push(g[0]);
    bottom.push(g[1]);
  }
  return [top.join(" "), bottom.join(" ")];
}

// --- Command palette ---------------------------------------------------------------------
// Typing "/" opens a live-filtered menu under the input (the Hermes/Claude-CLI pattern):
// ↑/↓ select, Tab completes, Enter runs, Esc dismisses. Client commands are listed here;
// the server's slash-commands (GET /commands) are merged in and, when run, are sent to
// the agent like any message.

export interface PaletteEntry {
  name: string; // includes the leading "/"
  desc: string;
  usage?: string; // shown instead of desc when present, Hermes-style "(usage: …)"
  takesArgs?: boolean; // Tab-completion appends a space
  server?: boolean; // an agent command — submit() sends it to the server
}

export const CLIENT_COMMANDS: PaletteEntry[] = [
  { name: "/help", desc: "Show commands and keys" },
  { name: "/new", desc: "Start a new session (fresh conversation)" },
  { name: "/sessions", desc: "List sessions, or switch (usage: /sessions [n])", takesArgs: true },
  { name: "/agents", desc: "Live agents dashboard (full screen — q returns)" },
  { name: "/activity", desc: "What every agent is doing right now" },
  { name: "/skills", desc: "Skills dashboard (library + pending — full screen)" },
  { name: "/crons", desc: "Schedules dashboard (brain + agent-armed — full screen)" },
  { name: "/status", desc: "Backend version, dispatcher, executor state" },
  { name: "/local", desc: "Execute commands on THIS machine (usage: /local on|off)", takesArgs: true },
  { name: "/yolo", desc: "Skip per-command approval — dangerous ones still ask (usage: /yolo on|off)", takesArgs: true },
  { name: "/stop", desc: "Stop the in-flight turn (also: Esc)" },
  { name: "/clear", desc: "Clear the screen (keeps the conversation)" },
  { name: "/quit", desc: "Exit (also: Ctrl-C twice)" },
];

// The palette is open exactly while the buffer is a bare "/word" (no space yet).
export function filterPalette(entries: PaletteEntry[], buffer: string): PaletteEntry[] {
  const m = buffer.match(/^\/([A-Za-z0-9_-]*)$/);
  if (!m) return [];
  const prefix = (m[1] ?? "").toLowerCase();
  return entries.filter((e) => e.name.slice(1).toLowerCase().startsWith(prefix));
}

function fmtClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => (n < 10 ? "0" : "") + n;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtK(n: number): string {
  return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n);
}

export async function runRemoteTui(profile: RemoteProfile & { password?: string }): Promise<void> {
  const session: RemoteSession = await createSession(profile);
  const screen = new Screen({
    write: (s) => process.stdout.write(s),
    columns: () => process.stdout.columns ?? 100,
  });
  const editor = new LineEditor();
  try {
    editor.loadHistory(fs.readFileSync(HISTORY_FILE, "utf8").split("\n").filter(Boolean));
  } catch {
    /* fresh history */
  }

  // --- State ---
  let gateway = "connecting";
  let execMode: "local" | "server" = profile.execution;
  let turnState = "idle"; // idle | waiting | streaming | tool: x | cypher · …
  let context: { inputTokens: number; window?: number } | null = null;
  let conversationId: string | undefined; // undefined = the Main thread
  let conversationLabel = "main";
  const startedAt = Date.now();
  let partialBuf = "";
  let streamedThisTurn = false;
  let pendingLines: string[] = [];
  let lastCtrlC = 0;
  let pendingConfirm:
    | { resolve: (a: "yes" | "no" | "always") => void; allowAlways: boolean }
    | null = null;
  // While a full-screen dashboard (e.g. /agents) is open, it owns the keyboard.
  let dashboardKeys: ((key: Key) => void) | null = null;

  const host = session.base.replace(/^https?:\/\//, "");

  function saveHistory(): void {
    try {
      fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
      fs.writeFileSync(HISTORY_FILE, editor.getHistory().join("\n") + "\n");
    } catch {
      /* history is best-effort */
    }
  }

  function status(): string {
    const gw = gateway === "connected" ? "⏺ ready" : `⏺ ${gateway}`;
    const exec = `exec:${execMode}${profile.approval === "yolo" ? "(yolo)" : ""}`;
    const ctx = context
      ? context.window
        ? `ctx ${fmtK(context.inputTokens)}/${fmtK(context.window)} ${Math.min(100, Math.round((context.inputTokens / context.window) * 100))}%`
        : `ctx ${fmtK(context.inputTokens)}`
      : "";
    const clock = fmtClock(Math.floor((Date.now() - startedAt) / 1000));
    return (
      DIM +
      [gw, host, `#${conversationLabel}`, exec, turnState !== "idle" ? turnState : "", ctx, clock]
        .filter(Boolean)
        .join(" · ") +
      RESET
    );
  }

  function promptStr(): string {
    return pendingLines.length ? "… " : "> ";
  }

  // --- Command palette state ---
  let palette: PaletteEntry[] = [...CLIENT_COMMANDS];
  let paletteMatches: PaletteEntry[] = [];
  let paletteIdx = 0;
  let paletteDismissed = ""; // the exact buffer Esc was pressed on (reopens when it changes)
  const PALETTE_ROWS = 10;

  function renderPalette(): void {
    const matches = paletteDismissed === editor.buffer ? [] : filterPalette(palette, editor.buffer);
    if (matches.length !== paletteMatches.length || !matches.every((m, i) => m === paletteMatches[i])) {
      paletteIdx = 0;
    }
    paletteMatches = matches;
    if (!matches.length) {
      screen.setMenu([]);
      return;
    }
    if (paletteIdx >= matches.length) paletteIdx = matches.length - 1;
    const shown = matches.slice(0, PALETTE_ROWS);
    const width = Math.max(...shown.map((e) => e.name.length)) + 3;
    const rows = shown.map((e, i) => {
      const sel = i === paletteIdx;
      const label = (sel ? "▸ " : "  ") + e.name.padEnd(width);
      const line = label + DIM + e.desc + (e.server ? " (agent)" : "") + RESET;
      return sel ? "\x1b[36m" + line.replace(DIM, "\x1b[0;36m") + RESET : line;
    });
    if (matches.length > PALETTE_ROWS) rows.push(DIM + `  … ${matches.length - PALETTE_ROWS} more — keep typing` + RESET);
    screen.setMenu(rows);
  }

  function refreshInput(): void {
    screen.setInput(promptStr(), editor.buffer, editor.cursor);
    renderPalette();
  }

  function out(line: string): void {
    screen.appendLine(line);
  }
  function dim(line: string): void {
    out(DIM + line + RESET);
  }

  // Streamed reply text: completed lines go to scrollback, the tail renders in the
  // partial row so streaming stays visible without breaking the reserved-row layout.
  function feedDelta(text: string): void {
    partialBuf += text;
    let nl: number;
    while ((nl = partialBuf.indexOf("\n")) !== -1) {
      out(partialBuf.slice(0, nl));
      partialBuf = partialBuf.slice(nl + 1);
    }
    screen.setPartial(partialBuf);
  }
  function flushPartial(): void {
    if (partialBuf) {
      out(partialBuf);
      partialBuf = "";
    }
    screen.setPartial("");
  }

  // --- Chat stream (one bare-key stream receives every conversation; filter locally) ---
  void consumeSse(
    session,
    `/events?externalUserId=${encodeURIComponent(session.externalUserId)}${session.authQuery}`,
    (event, data) => {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event === "heartbeat") return;
      // Filter to the open conversation (events for others still arrive on the bare key).
      const evConv = typeof d.conversationId === "string" ? d.conversationId : null;
      if (evConv && conversationId && evConv !== conversationId) return;
      if (evConv && !conversationId) {
        // We're on the Main thread; ignore traffic for named web conversations.
        // (Main-thread events carry the default session's id — resolved lazily below.)
        if (defaultConvId && evConv !== defaultConvId) return;
      }
      switch (event) {
        case "delta":
          streamedThisTurn = true;
          turnState = "streaming";
          feedDelta(String(d.text ?? ""));
          screen.setStatus(status());
          break;
        case "thinking":
          turnState = "thinking";
          screen.setStatus(status());
          break;
        case "tool":
          flushPartial();
          dim(`[tool: ${String(d.name ?? "")}] ${summarizeToolInput(d.input)}`);
          turnState = `tool: ${String(d.name ?? "")}`;
          screen.setStatus(status());
          break;
        case "subagent": {
          const pathArr = Array.isArray(d.path) ? d.path.map(String) : [];
          const label = pathArr.join(" › ") || "subagent";
          if (d.kind === "start") dim(`[${label}] ⚙ started`);
          else if (d.kind === "tool") dim(`[${label}] tool: ${String(d.name ?? "")}`);
          else if (d.kind === "end") dim(`[${label}] ${String(d.status ?? "done")}`);
          if (d.kind !== "end") turnState = label;
          screen.setStatus(status());
          break;
        }
        case "turn_done": {
          if (!streamedThisTurn && d.text) {
            for (const line of String(d.text).split("\n")) out(line);
          }
          flushPartial();
          streamedThisTurn = false;
          turnState = "idle";
          const usage = d.usage as { inputTokens?: number; outputTokens?: number } | undefined;
          const ctx = d.context as { inputTokens: number; window?: number } | undefined;
          if (ctx) context = ctx;
          dim(
            `— done${usage ? ` · ↑${fmtK(usage.inputTokens ?? 0)} ↓${fmtK(usage.outputTokens ?? 0)}` : ""}`,
          );
          screen.setStatus(status());
          break;
        }
        case "message":
          flushPartial();
          if (d.text) for (const line of String(d.text).split("\n")) out(line);
          turnState = "idle";
          screen.setStatus(status());
          break;
      }
    },
    (state) => {
      gateway = state === "connected" ? "connected" : "reconnecting";
      screen.setStatus(status());
    },
  );

  // --- Executor (local execution is the CLI's point; confirms render inline) ---
  startExecutor({
    session,
    workspace: profile.workspace,
    yolo: profile.approval === "yolo",
    callbacks: {
      output: (line) => dim(line),
      confirm: (cmd, danger, allowAlways) =>
        new Promise((resolve) => {
          pendingConfirm = { resolve, allowAlways };
          const dangerTag = danger ? "DANGEROUS — " : "";
          screen.setConfirm(
            `${dangerTag}run: ${cmd}  [y]es / [n]o${allowAlways ? " / [a]lways" : ""}`,
          );
        }),
    },
  });

  // --- Conversations ---
  let defaultConvId: string | undefined;
  void fetchers.conversations(session).then((j) => {
    defaultConvId = j?.defaultId;
  });

  async function listSessionsCmd(): Promise<void> {
    const j = await fetchers.conversations(session);
    if (!j) {
      dim("[sessions fetch failed]");
      return;
    }
    dim(`  0. main (cross-channel thread)${!conversationId ? "  ← current" : ""}`);
    j.conversations
      .filter((c) => c.id !== j.defaultId)
      .forEach((c, i) => {
        const label = String(c.title ?? "New chat");
        dim(`  ${i + 1}. ${label}${conversationId === c.id ? "  ← current" : ""}`);
      });
    dim("switch with /sessions <number>");
  }

  async function switchSession(n: number): Promise<void> {
    const j = await fetchers.conversations(session);
    if (!j) return;
    if (n === 0) {
      conversationId = undefined;
      conversationLabel = "main";
    } else {
      const named = j.conversations.filter((c) => c.id !== j.defaultId);
      const target = named[n - 1];
      if (!target) {
        dim(`no session #${n}`);
        return;
      }
      conversationId = String(target.id);
      conversationLabel = String(target.title ?? "chat").slice(0, 24);
    }
    dim(`[switched to #${conversationLabel}]`);
    screen.setStatus(status());
  }

  // Full-screen dashboard on the alternate buffer — the transcript is restored
  // untouched when the user returns (q / Esc). Nothing is dumped into the chat.
  async function openDashboard(view: DashboardView): Promise<void> {
    // Silence the chat screen first: its 1s status tick / streamed lines would paint
    // straight into the alternate buffer and corrupt the dashboard frame. Lines that
    // arrive meanwhile are held and flushed on resume.
    screen.suspend();
    process.stdout.write("\x1b[?1049h\x1b[?25l");
    try {
      await runDashboard(
        session,
        {
          write: (s) => process.stdout.write(s),
          columns: () => process.stdout.columns || 100,
          rows: () => process.stdout.rows || 30,
          onKey: (h) => {
            dashboardKeys = h;
          },
          pendingConfirm: () => pendingConfirm !== null,
        },
        view,
      );
    } finally {
      dashboardKeys = null;
      process.stdout.write("\x1b[?25h\x1b[?1049l");
      screen.resume(); // flushes anything that streamed in while the dashboard was up
      refreshInput();
    }
  }

  // --- Slash commands ---
  async function runCommand(text: string): Promise<boolean> {
    const [cmd, ...rest] = text.split(/\s+/);
    switch (cmd) {
      case "/help":
        for (const c of palette) dim(`${c.name.padEnd(12)} ${c.desc}${c.server ? " (agent)" : ""}`);
        dim("");
        dim("type / for the command menu — ↑/↓ select · Tab completes · Enter runs · Esc closes");
        dim("keys: Esc stops the turn · Ctrl-C twice quits · ↑/↓ history · \\ at line end continues");
        return true;
      case "/quit":
      case "/exit":
        quit();
        return true;
      case "/stop":
        dim((await abortTurn(session, conversationId ?? defaultConvId)) ? "[stopping…]" : "[nothing to stop]");
        return true;
      case "/clear":
        // Visual only — the conversation (and the agent's context) is untouched.
        screen.clear();
        printBanner();
        return true;
      case "/new": {
        const res = await fetch(`${session.base}/conversations?externalUserId=${encodeURIComponent(session.externalUserId)}`, {
          method: "POST",
          headers: session.headers(),
          body: "{}",
        }).then((r) => (r.ok ? (r.json() as Promise<{ id?: string; title?: string | null }>) : null)).catch(() => null);
        if (res?.id) {
          conversationId = res.id;
          conversationLabel = String(res.title ?? "new chat").slice(0, 24);
          dim(`[new session #${conversationLabel}]`);
          screen.setStatus(status());
        } else dim("[couldn't create a session]");
        return true;
      }
      case "/sessions":
        if (rest[0] !== undefined) await switchSession(parseInt(rest[0], 10) || 0);
        else await listSessionsCmd();
        return true;
      case "/agents":
        await openDashboard(agentsView);
        return true;
      case "/crons":
        await openDashboard(cronsView);
        return true;
      case "/activity": {
        const j = await fetchers.activity(session);
        for (const t of j?.turns ?? []) {
          const secs = Math.max(0, Math.floor((Date.now() - Date.parse(String(t.startedAt))) / 1000));
          dim(`${String(t.agent).padEnd(14)} ${t.activity ?? "working"} · ${t.channel} · ${secs}s`);
        }
        if (!j?.turns?.length) dim("(idle)");
        return true;
      }
      case "/skills":
        await openDashboard(skillsView);
        return true;
      case "/status": {
        const j = await fetchers.status(session);
        if (j) {
          dim(`backend v${j.version ?? "?"} · dispatcher ${j.dispatcher ?? "?"} · agents ${(j.agents as { count?: number })?.count ?? "?"}`);
          const re = j.remoteExec as { connected?: boolean } | undefined;
          dim(`executor: ${re?.connected ? "connected (this client)" : "not connected"} · workspace ${profile.workspace}`);
        } else dim("[status fetch failed]");
        return true;
      }
      case "/local":
        execMode = rest[0] === "off" ? "server" : "local";
        dim(`[execution: ${execMode === "local" ? "your machine" : "the server"}]`);
        screen.setStatus(status());
        return true;
      case "/yolo":
        profile.approval = rest[0] === "off" ? "ask" : "yolo";
        dim(`[approval: ${profile.approval}]`);
        screen.setStatus(status());
        return true;
      default:
        return false; // not a client command — send to the agent (server commands included)
    }
  }

  async function submit(text: string): Promise<void> {
    // Multi-line input: a trailing backslash continues on the next line.
    if (text.endsWith("\\")) {
      pendingLines.push(text.slice(0, -1));
      refreshInput();
      return;
    }
    const full = [...pendingLines, text].join("\n").trim();
    pendingLines = [];
    if (!full) {
      refreshInput();
      return;
    }
    if (full.startsWith("/") && (await runCommand(full))) {
      refreshInput();
      return;
    }
    out("");
    out(`${DIM}you:${RESET} ${full.split("\n").join(" ")}`);
    turnState = "waiting";
    screen.setStatus(status());
    const res = await sendMessage(session, full, execMode, conversationId).catch(() => ({ ok: false, status: 0 }));
    if (!res.ok) {
      dim(res.status === 401 ? "[unauthorized — check the token / login]" : `[send failed (HTTP ${res.status})]`);
      turnState = "idle";
      screen.setStatus(status());
    }
    saveHistory();
    refreshInput();
  }

  function quit(): void {
    saveHistory();
    process.stdout.write("\n");
    process.exit(0);
  }

  // --- Keyboard ---
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  // CRITICAL: prompts()/readline (the wizard, the password prompt) PAUSE stdin when they
  // close. A 'keypress' listener does not un-pause an explicitly-paused stream, so without
  // this resume the TUI boots deaf — no typing, and (raw mode) not even Ctrl-C.
  process.stdin.resume();
  process.stdin.on("keypress", (_str: string, key: Key) => {
    if (!key) return;
    // A full-screen dashboard owns the keyboard while open — INCLUDING when an executor
    // confirm fires underneath it: the prompt is invisible behind the alternate screen,
    // so answering it blind would be worse than useless. The dashboard shows an
    // "approval waiting — press q" notice; the prompt renders the moment you're back.
    if (dashboardKeys) {
      dashboardKeys(key);
      return;
    }
    // Confirm prompts capture the keyboard until answered.
    if (pendingConfirm) {
      const name = (key.name ?? key.sequence ?? "").toLowerCase();
      if (name === "y") answerConfirm("yes");
      else if (name === "a" && pendingConfirm.allowAlways) answerConfirm("always");
      else if (name === "n" || name === "escape" || (key.ctrl && name === "c")) answerConfirm("no");
      return;
    }
    if (key.ctrl && key.name === "c") {
      const now = Date.now();
      if (now - lastCtrlC < 1500) quit();
      lastCtrlC = now;
      editor.buffer = "";
      editor.cursor = 0;
      pendingLines = [];
      dim("[input cleared — Ctrl-C again to quit]");
      refreshInput();
      return;
    }
    // The palette captures navigation keys while open: ↑/↓ select, Tab completes,
    // Enter runs the selection, Esc dismisses (Esc's stop-the-turn meaning returns
    // once the palette is closed).
    if (paletteMatches.length > 0) {
      const shown = Math.min(paletteMatches.length, PALETTE_ROWS);
      const sel = paletteMatches[Math.min(paletteIdx, paletteMatches.length - 1)]!;
      if (key.name === "up") {
        paletteIdx = (paletteIdx - 1 + shown) % shown;
        renderPalette();
        return;
      }
      if (key.name === "down") {
        paletteIdx = (paletteIdx + 1) % shown;
        renderPalette();
        return;
      }
      if (key.name === "tab") {
        editor.buffer = sel.name + (sel.takesArgs ? " " : "");
        editor.cursor = editor.buffer.length;
        refreshInput();
        return;
      }
      if (key.name === "escape") {
        paletteDismissed = editor.buffer;
        renderPalette();
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        // Run the SELECTED command (what the highlight promises), then let the
        // editor's own Enter handling submit it (history included).
        editor.buffer = sel.name;
        editor.cursor = sel.name.length;
      }
    }
    if (key.name === "escape") {
      void abortTurn(session, conversationId ?? defaultConvId).then((stopped) => {
        dim(stopped ? "[stopping…]" : "[nothing to stop]");
      });
      return;
    }
    const result = editor.handle(key);
    if (result) void submit(result.submit);
    else refreshInput();
  });
  function answerConfirm(a: "yes" | "no" | "always"): void {
    const pc = pendingConfirm;
    pendingConfirm = null;
    screen.setConfirm(null);
    refreshInput();
    pc?.resolve(a);
  }

  // Welcome card (the Claude-Code look): a FULL-WIDTH rounded teal frame with the
  // block-art wordmark + connection facts. Printed at boot and again by /clear.
  function printBanner(): void {
    const art = blockArt("DAEDALUS");
    const cols = process.stdout.columns || 100; // `||`: some PTYs report 0 columns
    const cardLines: string[] = [];
    if (art && art[0].length <= cols - 6) {
      cardLines.push(TEAL + art[0] + RESET, TEAL + art[1] + RESET, "");
    } else {
      cardLines.push(TEAL + "DAEDALUS" + RESET, "");
    }
    cardLines.push(DIM + `${host} · workspace ${profile.workspace}` + RESET);
    cardLines.push(DIM + `execution ${execMode} · approval ${profile.approval} · /help for commands` + RESET);
    for (const line of boxify(cardLines, cols - 1, `dae v${cliVersion()}`)) out(line);
  }

  // --- Boot ---
  // Fresh screen: the app owns the terminal from here (history above scrolls naturally
  // as the session grows — same behaviour as the Claude-Code CLI). The live roster line
  // (backend version · agents · skills) prints under the card when the fetches land.
  process.stdout.write("\x1b[2J\x1b[H");
  screen.start();
  printBanner();
  // Agent slash-commands (the brain's + the channel built-ins) join the palette; running
  // one sends it to the agent like any message. Client names win on collision.
  void fetchers
    .commands(session)
    .then((j) => {
      const mine = new Set(CLIENT_COMMANDS.map((c) => c.name));
      const extra = (j?.commands ?? [])
        .map((c) => ({
          name: "/" + String(c.name).replace(/^\//, ""),
          desc: String(c.description ?? "agent command"),
          server: true,
        }))
        .filter((c) => !mine.has(c.name));
      if (extra.length) {
        palette = [...CLIENT_COMMANDS, ...extra];
        renderPalette();
      }
    })
    .catch(() => {});
  void Promise.all([
    fetchers.status(session).catch(() => null),
    fetchers.skills(session).catch(() => null),
  ]).then(([st, sk]) => {
    const bits: string[] = [];
    const stAgents = st && (st.agents as { count?: number } | undefined);
    if (st?.version) bits.push(`backend v${String(st.version)}`);
    if (stAgents?.count != null) bits.push(`${stAgents.count} agents`);
    if (sk) bits.push(`${(sk.skills ?? []).length} skills${(sk.pending ?? []).length ? ` (+${sk.pending.length} pending)` : ""}`);
    if (st && (st.schedules as { static?: number } | undefined)) {
      const sch = st.schedules as { static?: number; dynamic?: number };
      bits.push(`${(sch.static ?? 0) + (sch.dynamic ?? 0)} cron`);
    }
    if (bits.length) dim(bits.join(" · "));
  });
  screen.setStatus(status());
  refreshInput();
  setInterval(() => screen.setStatus(status()), 1000);

  await new Promise(() => {});
}

function summarizeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;
  for (const k of ["command", "cmd", "url", "path", "query", "name"]) {
    if (typeof obj[k] === "string") return String(obj[k]).slice(0, 80);
  }
  return "";
}
