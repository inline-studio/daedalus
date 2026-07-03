import readline from "node:readline";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { exec as childExec } from "node:child_process";
import { log } from "../log.js";

// `dae remote` — the laptop half of remote execution. One process, two jobs:
//
//   1. A chat REPL on the server's web channel: stdin lines POST to /messages, replies
//      and live turn events render from the /events SSE stream (same rendering idea as
//      the local CLI channel: streamed text, dim tool lines, subagent prefixes).
//
//   2. The EXECUTOR for this user: a second SSE stream (/rpc/stream) delivers
//      exec/read/write requests from the user's own turns; they run HERE — in the
//      declared workspace — and results POST back to /rpc/result.
//
// Everything is outbound HTTP from the laptop: no listening port, no tunnel, works
// behind NAT. Auth is the web channel's own (bearer token, or username/password login
// exchanged for the session cookie).
//
// Safety model (the agent gets arbitrary shell on this machine, so):
//   - every exec prompts for confirmation by default; `a` answers persist a prefix
//     allowlist (~/.daedalus/remote-allow.json) so routine commands stop asking
//   - a denylist of catastrophic patterns ALWAYS prompts — even under --yolo
//   - file reads/writes are confined to the workspace directory
//   - every executed command is appended to ~/.daedalus/remote-exec.log

export interface RemoteClientOptions {
  url: string;
  token?: string;
  username?: string;
  password?: string;
  workspace: string;
  yolo: boolean;
  externalUserId?: string;
}

interface RpcRequest {
  id: string;
  kind: "exec" | "read" | "write";
  cmd?: string;
  timeoutMs?: number;
  path?: string;
  content?: string;
}

// --- Command policy (pure; exported for tests) --------------------------------------

// Patterns that are never auto-approved, no matter what — a wrong `y` here is a wiped
// disk or an escalated shell, so the human always sees them.
const DENYLIST: RegExp[] = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\b/i, // rm -rf and friends
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^|;&]*\bof=\/dev\//i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bchmod\s+[0-7]*\s+\/(\s|$)/, // chmod on filesystem root
  />\s*\/dev\/sd[a-z]\b/i,
];

export type CommandVerdict = "auto" | "prompt" | "danger-prompt";

export function evaluateCommand(cmd: string, allowlist: string[], yolo: boolean): CommandVerdict {
  const trimmed = cmd.trim();
  if (DENYLIST.some((re) => re.test(trimmed))) return "danger-prompt";
  if (yolo) return "auto";
  if (allowlist.some((prefix) => prefix && trimmed.startsWith(prefix))) return "auto";
  return "prompt";
}

// The allowlist prefix an "always" answer records: the command's first two tokens
// ("git status", "npm test") — specific enough not to blanket-approve a whole binary
// with dangerous flags, general enough to stop re-asking for the routine stuff.
export function allowPrefixFor(cmd: string): string {
  return cmd.trim().split(/\s+/).slice(0, 2).join(" ");
}

// Confine a requested file path to the workspace: relative paths resolve inside it,
// absolute paths must already be inside it. Throws otherwise (exported for tests).
export function confineToWorkspace(workspace: string, requested: string): string {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, requested);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path '${requested}' is outside the workspace (${root})`);
  }
  return resolved;
}

// --- The client ----------------------------------------------------------------------

const ALLOW_FILE = path.join(os.homedir(), ".daedalus", "remote-allow.json");
const AUDIT_FILE = path.join(os.homedir(), ".daedalus", "remote-exec.log");
const OUTPUT_CAP = 200_000; // chars per stream sent back to the server

function loadAllowlist(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function saveAllowlist(list: string[]): void {
  try {
    fs.mkdirSync(path.dirname(ALLOW_FILE), { recursive: true });
    fs.writeFileSync(ALLOW_FILE, JSON.stringify([...new Set(list)].sort(), null, 2));
  } catch (err) {
    log.warn({ err: (err as Error).message }, "remote: could not persist allowlist");
  }
}

function audit(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* auditing must never block execution */
  }
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

export async function runRemoteClient(opts: RemoteClientOptions): Promise<void> {
  const base = opts.url.replace(/\/$/, "");
  const externalUserId = opts.externalUserId ?? `remote-${os.hostname().split(".")[0]}`;
  const workspace = path.resolve(opts.workspace);
  fs.mkdirSync(workspace, { recursive: true });
  let allowlist = loadAllowlist();

  // --- Auth: bearer token, or login → session cookie ---
  let cookie: string | undefined;
  const authHeaders = (): Record<string, string> => ({
    "content-type": "application/json",
    ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
    ...(cookie ? { cookie } : {}),
  });
  const authQuery = opts.token ? `&token=${encodeURIComponent(opts.token)}` : "";

  if (opts.username) {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: opts.username, password: opts.password ?? "" }),
    });
    if (!res.ok) throw new Error(`login failed (HTTP ${res.status})`);
    const setCookie = res.headers.get("set-cookie");
    const m = setCookie?.match(/dae_session=[^;]+/);
    if (!m) throw new Error("login succeeded but no session cookie was returned");
    cookie = m[0];
  }

  process.stdout.write(
    `[dae remote] server: ${base}\n` +
      `[dae remote] user: ${externalUserId} · workspace: ${workspace}` +
      `${opts.yolo ? " · YOLO (exec auto-approved)" : ""}\n`,
  );

  // --- Confirmation prompting (shares the terminal with the REPL) ---
  // Without a TTY (backgrounded / systemd / CI) there is no REPL and no way to confirm:
  // the client runs as an executor only, and anything that would have prompted is
  // refused — never silently approved.
  const interactive = Boolean(process.stdin.isTTY);
  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;
  let asking = false;
  const ask = (q: string): Promise<string> => {
    if (!rl) return Promise.resolve("n");
    return new Promise((resolve) => {
      asking = true;
      rl.question(q, (answer) => {
        asking = false;
        resolve(answer.trim().toLowerCase());
      });
    });
  };
  const prompt = () => {
    if (interactive && !asking) process.stdout.write("> ");
  };

  // --- Request execution ---
  async function handleRequest(reqObj: RpcRequest): Promise<Record<string, unknown>> {
    if (reqObj.kind === "read") {
      try {
        const p = confineToWorkspace(workspace, String(reqObj.path ?? ""));
        process.stdout.write(dim(`\n[read] ${p}\n`));
        return { id: reqObj.id, ok: true, content: fs.readFileSync(p, "utf8") };
      } catch (err) {
        return { id: reqObj.id, ok: false, error: (err as Error).message };
      }
    }
    if (reqObj.kind === "write") {
      try {
        const p = confineToWorkspace(workspace, String(reqObj.path ?? ""));
        process.stdout.write(dim(`\n[write] ${p} (${String(reqObj.content ?? "").length} chars)\n`));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(reqObj.content ?? ""), "utf8");
        audit({ kind: "write", path: p });
        return { id: reqObj.id, ok: true };
      } catch (err) {
        return { id: reqObj.id, ok: false, error: (err as Error).message };
      }
    }
    // exec
    const cmd = String(reqObj.cmd ?? "");
    const verdict = evaluateCommand(cmd, allowlist, opts.yolo);
    if (verdict !== "auto") {
      const danger = verdict === "danger-prompt" ? " \x1b[31m[DANGEROUS]\x1b[0m" : "";
      const answer = await ask(`\n[exec]${danger} ${cmd}\n  run this? [y/N${verdict === "prompt" ? "/a=always" : ""}] `);
      if (verdict === "prompt" && answer === "a") {
        allowlist = [...allowlist, allowPrefixFor(cmd)];
        saveAllowlist(allowlist);
      } else if (answer !== "y" && answer !== "yes") {
        audit({ kind: "exec", cmd, refused: true });
        prompt();
        return { id: reqObj.id, ok: false, error: "the user declined to run this command" };
      }
      prompt();
    } else {
      process.stdout.write(dim(`\n[exec] ${cmd}\n`));
    }
    const timeoutMs = Math.min(reqObj.timeoutMs ?? 120_000, 10 * 60_000);
    const started = Date.now();
    return new Promise((resolve) => {
      childExec(cmd, { cwd: workspace, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        const timedOut = Boolean(err && (err as { killed?: boolean }).killed);
        const exitCode = err ? ((err as { code?: number }).code ?? 1) : 0;
        audit({ kind: "exec", cmd, exitCode, timedOut, durationMs: Date.now() - started });
        resolve({
          id: reqObj.id,
          ok: exitCode === 0,
          stdout: String(stdout).slice(0, OUTPUT_CAP),
          stderr: String(stderr).slice(0, OUTPUT_CAP),
          exitCode: typeof exitCode === "number" ? exitCode : 1,
          timedOut,
        });
      });
    });
  }

  // --- SSE consumption (plain fetch; reconnect with backoff) ---
  async function consumeSse(
    pathAndQuery: string,
    onEvent: (event: string, data: string) => void,
    label: string,
  ): Promise<never> {
    for (;;) {
      try {
        const res = await fetch(`${base}${pathAndQuery}`, { headers: authHeaders() });
        if (res.status === 401) throw new Error("unauthorized — check the token / login");
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            const block = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            let event = "message";
            const dataLines: string[] = [];
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
            }
            if (dataLines.length) onEvent(event, dataLines.join("\n"));
          }
        }
        throw new Error("stream ended");
      } catch (err) {
        process.stdout.write(dim(`\n[${label}] disconnected (${(err as Error).message}) — retrying…\n`));
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  // Executor stream: run requests, POST results back.
  void consumeSse(
    `/rpc/stream?externalUserId=${encodeURIComponent(externalUserId)}&workspace=${encodeURIComponent(workspace)}${authQuery}`,
    (event, data) => {
      if (event !== "request") return;
      let reqObj: RpcRequest;
      try {
        reqObj = JSON.parse(data) as RpcRequest;
      } catch {
        return;
      }
      void handleRequest(reqObj).then((result) =>
        fetch(`${base}/rpc/result?externalUserId=${encodeURIComponent(externalUserId)}`, {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(result),
        }).catch((err) => log.warn({ err: (err as Error).message }, "remote: result POST failed")),
      );
    },
    "executor",
  );

  // Chat stream: render replies + live turn events.
  let streamedThisTurn = false;
  void consumeSse(
    `/events?externalUserId=${encodeURIComponent(externalUserId)}${authQuery}`,
    (event, data) => {
      let d: Record<string, unknown>;
      try {
        d = JSON.parse(data) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (event) {
        case "delta":
          streamedThisTurn = true;
          process.stdout.write(String(d.text ?? ""));
          break;
        case "thinking":
          break; // reasoning stays quiet on the remote CLI
        case "tool":
          process.stdout.write(dim(`\n[tool: ${String(d.name ?? "")}]\n`));
          break;
        case "subagent": {
          const pathArr = Array.isArray(d.path) ? d.path.map(String) : [];
          const label = pathArr.join(" › ") || "subagent";
          if (d.kind === "start") process.stdout.write(dim(`\n[${label}] ⚙ started\n`));
          else if (d.kind === "tool") process.stdout.write(dim(`[${label}] tool: ${String(d.name ?? "")}\n`));
          else if (d.kind === "end") process.stdout.write(dim(`[${label}] ${String(d.status ?? "done")}\n`));
          break;
        }
        case "turn_done":
          if (!streamedThisTurn && d.text) process.stdout.write(`\n${String(d.text)}\n`);
          streamedThisTurn = false;
          process.stdout.write("\n");
          prompt();
          break;
        case "message":
          // Buffered replies (non-streaming dispatch) and replay.
          if (d.text) process.stdout.write(`\n${String(d.text)}\n`);
          prompt();
          break;
      }
    },
    "chat",
  );

  // --- REPL (interactive terminals only; headless runs are executor-only) ---
  if (rl) {
    process.stdout.write(`[dae remote] connected — type a message; Ctrl-C to exit\n> `);
    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) {
        prompt();
        return;
      }
      void fetch(`${base}/messages`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ externalUserId, text }),
      })
        .then((r) => {
          if (r.status === 401) process.stdout.write("unauthorized — check the token / login\n");
          else if (!r.ok) process.stdout.write(`send failed (HTTP ${r.status})\n`);
        })
        .catch((err) => process.stdout.write(`send failed: ${(err as Error).message}\n`));
    });
    rl.on("close", () => {
      process.stdout.write("\n[dae remote] bye\n");
      process.exit(0);
    });
  } else {
    process.stdout.write(
      `[dae remote] no TTY — executor-only mode (chat from another surface; ` +
        `commands needing confirmation are refused${opts.yolo ? "" : "; consider --yolo for trusted setups"})\n`,
    );
  }

  // Keep the process alive on the streams + REPL.
  await new Promise(() => {});
}
