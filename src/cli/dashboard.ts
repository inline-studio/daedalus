import { type RemoteSession, fetchers } from "./remote-shared.js";
import { visibleTruncate, visibleLength, DIM, RESET, type Key } from "./tui.js";

// Full-screen (alternate-buffer) dashboards — the terminal equivalent of the desktop
// app's modal panels. One windowed shell, three views (/agents, /skills, /crons):
//
//   ╭ header: title + key hints ─────────────────────────────╮
//   │ list (left pane)        │ selected item (right pane)   │
//   │ ▸ ● cypher  bash — …    │ cypher — ACTIVE via web · 42s│
//   │   ○ vector              │ 10:04:18 tool: bash — npm t… │
//   ╰─────────────────────────┴──────────────────────────────╯
//
// ↑/↓ select (scroll-windowed), q/Esc/Ctrl-C return to the chat — the alternate screen
// restores the transcript untouched. Row shaping is pure and unit-tested.

const TEAL = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BOLD = "\x1b[1m";

// One list entry: how it renders on the left, and its detail lines on the right.
export interface DashRow {
  name: string;
  dot: "on" | "off" | null; // ● live / ○ idle / no dot
  sub: string; // dim label after the name in the list
  right: (width: number, rows: number) => string[]; // detail lines (unpadded, pre-styled)
}

export interface DashboardView {
  title: string;
  load: (session: RemoteSession) => Promise<DashRow[]>;
}

function fmtSince(iso: string): string {
  const s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}m${s % 60}s` : `${s}s`;
}

function pad(line: string, width: number): string {
  const cut = visibleTruncate(line, width);
  return cut + " ".repeat(Math.max(0, width - visibleLength(cut)));
}

// Greedy word-wrap for plain description text.
export function wrapText(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (!word) continue;
    if (line && line.length + 1 + word.length > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? line + " " + word : word;
    }
  }
  if (line) out.push(line);
  return out;
}

// --- Agents view -------------------------------------------------------------------------

export interface DashStep {
  at: string;
  label: string;
}

export interface DashAgent {
  name: string;
  model?: string;
  description?: string;
  busy: { channel: string; startedAt: string; steps: DashStep[] } | null;
}

// Attribute live activity to sub-agents from the turn logs (mirrors the web modal):
// chain-prefixed labels ("cypher · tool: bash", "cypher › reviewer · …") and spawns
// belong to that sub-agent; an agent can also BE a turn's top-level agent (cron fires).
export function shapeAgents(
  roster: Array<Record<string, unknown>>,
  turns: Array<Record<string, unknown>>,
): DashAgent[] {
  const subs = roster.filter((a) => !a.orchestrator);
  const busy = new Map<string, { channel: string; startedAt: string; steps: DashStep[] }>();
  const claim = (name: string, t: Record<string, unknown>, step: DashStep): void => {
    let b = busy.get(name);
    if (!b) {
      b = { channel: String(t.channel ?? "?"), startedAt: step.at || String(t.startedAt ?? ""), steps: [] };
      busy.set(name, b);
    }
    b.steps.push(step);
  };
  for (const t of turns) {
    const log = (t.log as Array<{ at: string; label: string }> | undefined) ?? [];
    const steps = log.length ? log : [{ at: String(t.startedAt ?? ""), label: String(t.activity ?? "working") }];
    for (const s of steps) {
      for (const a of subs) {
        const n = String(a.name);
        if (t.agent === n) {
          claim(n, t, s);
          continue;
        }
        if (s.label === `spawning ${n}`) claim(n, t, { at: s.at, label: "spawned" });
        else if (s.label.startsWith(`${n} · `) || s.label.startsWith(`${n} › `)) {
          claim(n, t, { at: s.at, label: s.label.slice(n.length + 3) });
        }
      }
    }
  }
  const out: DashAgent[] = subs.map((a) => ({
    name: String(a.name),
    ...(a.model ? { model: String(a.model) } : {}),
    ...(a.description ? { description: String(a.description) } : {}),
    busy: busy.get(String(a.name)) ?? null,
  }));
  out.sort((x, y) => {
    if (Boolean(x.busy) !== Boolean(y.busy)) return x.busy ? -1 : 1;
    if (x.busy && y.busy) return x.busy.startedAt.localeCompare(y.busy.startedAt);
    return x.name.localeCompare(y.name);
  });
  return out;
}

export function agentRows(agents: DashAgent[]): DashRow[] {
  return agents.map((a) => ({
    name: a.name,
    dot: a.busy ? ("on" as const) : ("off" as const),
    sub: a.busy ? (a.busy.steps[a.busy.steps.length - 1]?.label ?? "working") : (a.model ?? ""),
    right: (width, rows) => {
      const lines: string[] = [];
      if (a.busy) {
        lines.push(`${BOLD}${a.name}${RESET}  ${GREEN}ACTIVE${RESET} ${DIM}via ${a.busy.channel} · ${fmtSince(a.busy.startedAt)}${RESET}`);
        lines.push(DIM + "─".repeat(Math.max(1, width)) + RESET);
        for (const s of a.busy.steps.slice(-(rows - 2))) {
          const t = String(s.at).slice(11, 19);
          const style = s.label.startsWith("tool failed") ? "\x1b[31m" : s.label.startsWith("tool:") ? TEAL : s.label.startsWith("thinking") ? DIM : "";
          lines.push(`${DIM}${t}${RESET} ${style}${s.label}${style ? RESET : ""}`);
        }
      } else {
        lines.push(`${BOLD}${a.name}${RESET}  ${DIM}idle${RESET}`);
        lines.push(DIM + "─".repeat(Math.max(1, width)) + RESET);
        if (a.description) lines.push(...wrapText(a.description, width));
        if (a.model) lines.push(`${DIM}model${RESET} ${a.model}`);
      }
      return lines;
    },
  }));
}

export const agentsView: DashboardView = {
  title: "AGENTS · ACTIVITY",
  load: async (session) => {
    const [ag, ac] = await Promise.all([
      fetchers.agents(session).catch(() => null),
      fetchers.activity(session).catch(() => null),
    ]);
    return agentRows(shapeAgents(ag?.agents ?? [], ac?.turns ?? []));
  },
};

// --- Skills view -------------------------------------------------------------------------

export function skillRows(j: {
  skills: Array<Record<string, unknown>>;
  pending: Array<Record<string, unknown>>;
}): DashRow[] {
  const pending = (j.pending ?? []).map((p) => ({
    name: String(p.name),
    dot: "on" as const,
    sub: `PENDING (${p.patchesExisting ? "patch" : "new"})`,
    right: (width: number) => [
      `${BOLD}${String(p.name)}${RESET}  ${YELLOW}PENDING ${p.patchesExisting ? "patch" : "new skill"}${RESET}`,
      DIM + "─".repeat(Math.max(1, width)) + RESET,
      ...wrapText(String(p.description ?? "(no description)"), width),
      "",
      `${DIM}approve/reject from the web or desktop Skills panel${RESET}`,
    ],
  }));
  const skills = (j.skills ?? []).map((s) => {
    const marks = [
      s.origin === "agent" ? "agent-created" : null,
      s.status === "stale" ? "stale" : null,
      s.pinned ? "pinned" : null,
    ].filter(Boolean) as string[];
    return {
      name: String(s.name),
      dot: null,
      sub: marks.join(", "),
      right: (width: number) => [
        `${BOLD}${String(s.name)}${RESET}${marks.length ? `  ${DIM}[${marks.join(", ")}]${RESET}` : ""}`,
        DIM + "─".repeat(Math.max(1, width)) + RESET,
        ...wrapText(String(s.description ?? "(no description)"), width),
      ],
    };
  });
  return [...pending, ...skills];
}

export const skillsView: DashboardView = {
  title: "SKILLS",
  load: async (session) => {
    const j = await fetchers.skills(session).catch(() => null);
    return skillRows({ skills: j?.skills ?? [], pending: j?.pending ?? [] });
  },
};

// --- Crons view --------------------------------------------------------------------------

export function cronRows(j: {
  static: Array<Record<string, unknown>>;
  dynamic: Array<Record<string, unknown>>;
}): DashRow[] {
  const statics = (j.static ?? []).map((s) => ({
    name: String(s.name),
    dot: (s.enabled ? "on" : "off") as "on" | "off",
    sub: String(s.schedule ?? ""),
    right: (width: number) => [
      `${BOLD}${String(s.name)}${RESET}  ${s.enabled ? `${GREEN}enabled${RESET}` : `${DIM}disabled${RESET}`}`,
      DIM + "─".repeat(Math.max(1, width)) + RESET,
      `${DIM}schedule${RESET}  ${String(s.schedule ?? "?")}`,
      `${DIM}agent${RESET}     ${String(s.agent ?? "?")}`,
      `${DIM}source${RESET}    brain (schedules/)`,
    ],
  }));
  const dynamic = (j.dynamic ?? []).map((d) => ({
    name: String(d.prompt ?? d.id).slice(0, 40),
    dot: "on" as const,
    sub: String(d.recurring ?? `next ${String(d.nextFire ?? "?")}`),
    right: (width: number) => [
      `${BOLD}agent-armed schedule${RESET}`,
      DIM + "─".repeat(Math.max(1, width)) + RESET,
      ...wrapText(String(d.prompt ?? "(no prompt)"), width),
      "",
      `${DIM}when${RESET}      ${String(d.recurring ?? `next ${String(d.nextFire ?? "?")}`)}`,
      `${DIM}agent${RESET}     ${String(d.agent ?? "?")}`,
      `${DIM}armed by${RESET}  ${String(d.createdBy ?? "?")}`,
    ],
  }));
  return [...statics, ...dynamic];
}

export const cronsView: DashboardView = {
  title: "SCHEDULES",
  load: async (session) => {
    const j = await fetchers.schedules(session).catch(() => null);
    return cronRows({ static: j?.static ?? [], dynamic: j?.dynamic ?? [] });
  },
};

// --- The windowed shell --------------------------------------------------------------------

// Pure renderer: the full frame as padded lines (testable without a terminal).
export function renderFrame(
  rows: DashRow[],
  sel: number,
  cols: number,
  termRows: number,
  title: string,
  notice?: string,
): string[] {
  const leftW = Math.max(20, Math.min(32, Math.floor(cols * 0.3)));
  const rightW = cols - leftW - 3; // " │ "
  const lines: string[] = [];
  lines.push(pad(`${BOLD}${TEAL}${title}${RESET}  ${DIM}↑/↓ select · q back to chat${RESET}${notice ? `  ${YELLOW}${notice}${RESET}` : ""}`, cols));
  lines.push(TEAL + "─".repeat(cols) + RESET);

  const bodyRows = Math.max(3, termRows - 3);
  const selRow = rows[Math.min(sel, Math.max(0, rows.length - 1))];
  const right = selRow ? selRow.right(rightW, bodyRows) : [`${DIM}(nothing here yet)${RESET}`];

  // Scroll window: keep the selection visible when the list outgrows the pane.
  const offset = Math.max(0, Math.min(sel - (bodyRows - 1), rows.length - bodyRows));
  for (let i = 0; i < bodyRows; i++) {
    const idx = i + Math.max(0, offset);
    const r = rows[idx];
    let left = "";
    if (r) {
      const marker = idx === sel ? `${TEAL}▸ ${RESET}` : "  ";
      const dot = r.dot === "on" ? `${GREEN}●${RESET} ` : r.dot === "off" ? `${DIM}○${RESET} ` : "";
      const name = idx === sel ? `${BOLD}${r.name}${RESET}` : r.name;
      left = `${marker}${dot}${name} ${DIM}${r.sub}${RESET}`;
    } else if (i === 0 && rows.length === 0) {
      left = `${DIM}(none)${RESET}`;
    }
    lines.push(pad(left, leftW) + TEAL + " │ " + RESET + pad(right[i] ?? "", rightW));
  }
  return lines;
}

export interface DashboardIO {
  write: (s: string) => void;
  columns: () => number;
  rows: () => number;
  // Install (or remove, with null) the dashboard's keypress handler.
  onKey: (handler: ((key: Key) => void) | null) => void;
  // A command-approval prompt is waiting back in the chat view.
  pendingConfirm: () => boolean;
}

// Run a dashboard view until the user leaves (q / Esc / Ctrl-C). The CALLER owns the
// alternate-screen switch so terminal state handling lives in one place.
export function runDashboard(session: RemoteSession, io: DashboardIO, view: DashboardView): Promise<void> {
  return new Promise((resolve) => {
    let rows: DashRow[] = [];
    let sel = 0;
    let closed = false;

    const paint = (): void => {
      if (closed) return;
      const cols = Math.max(40, io.columns());
      const termRows = Math.max(8, io.rows());
      const notice = io.pendingConfirm() ? "⚠ approval waiting — press q" : undefined;
      io.write("\x1b[H" + renderFrame(rows, sel, cols, termRows, view.title, notice).join("\r\n"));
    };

    const load = (): void => {
      void view.load(session).then((r) => {
        if (closed) return;
        rows = r;
        if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
        paint();
      });
    };

    const timer = setInterval(load, 2500);
    const close = (): void => {
      closed = true;
      clearInterval(timer);
      io.onKey(null);
      resolve();
    };
    io.onKey((key) => {
      const name = key.name ?? "";
      if (name === "q" || name === "escape" || (key.ctrl && name === "c")) {
        close();
        return;
      }
      if (name === "up" && rows.length) {
        sel = (sel - 1 + rows.length) % rows.length;
        paint();
      } else if (name === "down" && rows.length) {
        sel = (sel + 1) % rows.length;
        paint();
      }
    });
    io.write("\x1b[2J\x1b[H");
    load();
  });
}
