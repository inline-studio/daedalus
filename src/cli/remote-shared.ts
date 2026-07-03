import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec as childExec } from "node:child_process";
import { log } from "../log.js";

// Shared plumbing for the `dae remote` client, used by BOTH renderers — the plain
// line-mode (remote-client.ts, also the no-TTY executor-only mode) and the full
// terminal interface (remote-tui.ts). Everything here is transport + policy; nothing
// writes to the terminal except through injected callbacks.

// --- Profile (~/.daedalus/remote.json) ------------------------------------------------

export interface RemoteProfile {
  url: string;
  // Auth: a bearer token, or a username for cookie login (password prompted per run —
  // never persisted), or neither (open server / proxy-authenticated).
  token?: string;
  username?: string;
  workspace: string;
  // Default execution placement for messages sent from this client.
  execution: "local" | "server";
  // Executor approval mode: ask per command, or yolo (denylist still prompts).
  approval: "ask" | "yolo";
  externalUserId?: string;
}

const PROFILE_FILE = path.join(os.homedir(), ".daedalus", "remote.json");

export function loadProfile(): Partial<RemoteProfile> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(PROFILE_FILE, "utf8")) as Partial<RemoteProfile>;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function saveProfile(profile: RemoteProfile): void {
  fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
  // The password is never part of the profile; everything else persists.
  fs.writeFileSync(PROFILE_FILE, JSON.stringify(profile, null, 2) + "\n");
}

export function profilePath(): string {
  return PROFILE_FILE;
}

// --- Command policy (pure) ------------------------------------------------------------

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
// absolute paths must already be inside it. Throws otherwise.
export function confineToWorkspace(workspace: string, requested: string): string {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, requested);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path '${requested}' is outside the workspace (${root})`);
  }
  return resolved;
}

// --- Allowlist + audit files ----------------------------------------------------------

const ALLOW_FILE = path.join(os.homedir(), ".daedalus", "remote-allow.json");
const AUDIT_FILE = path.join(os.homedir(), ".daedalus", "remote-exec.log");
const OUTPUT_CAP = 200_000; // chars per stream sent back to the server

export function loadAllowlist(): string[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

export function saveAllowlist(list: string[]): void {
  try {
    fs.mkdirSync(path.dirname(ALLOW_FILE), { recursive: true });
    fs.writeFileSync(ALLOW_FILE, JSON.stringify([...new Set(list)].sort(), null, 2));
  } catch (err) {
    log.warn({ err: (err as Error).message }, "remote: could not persist allowlist");
  }
}

export function audit(entry: Record<string, unknown>): void {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    /* auditing must never block execution */
  }
}

// --- Session (auth + endpoints) ---------------------------------------------------------

export interface RemoteSession {
  base: string;
  externalUserId: string;
  headers(): Record<string, string>;
  authQuery: string;
}

export async function createSession(opts: {
  url: string;
  token?: string;
  username?: string;
  password?: string;
  externalUserId?: string;
}): Promise<RemoteSession> {
  const base = opts.url.replace(/\/$/, "");
  const externalUserId = opts.externalUserId ?? `remote-${os.hostname().split(".")[0]}`;
  let cookie: string | undefined;
  if (opts.username) {
    const res = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: opts.username, password: opts.password ?? "" }),
    });
    if (!res.ok) throw new Error(`login failed (HTTP ${res.status})`);
    const m = res.headers.get("set-cookie")?.match(/dae_session=[^;]+/);
    if (!m) throw new Error("login succeeded but no session cookie was returned");
    cookie = m[0];
  }
  return {
    base,
    externalUserId,
    headers: () => ({
      "content-type": "application/json",
      ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
      ...(cookie ? { cookie } : {}),
    }),
    authQuery: opts.token ? `&token=${encodeURIComponent(opts.token)}` : "",
  };
}

// --- SSE consumption (plain fetch; reconnect with backoff) ------------------------------

export async function consumeSse(
  session: RemoteSession,
  pathAndQuery: string,
  onEvent: (event: string, data: string) => void,
  onState: (state: "connected" | "reconnecting", detail?: string) => void,
): Promise<never> {
  for (;;) {
    try {
      const res = await fetch(`${session.base}${pathAndQuery}`, { headers: session.headers() });
      if (res.status === 401) throw new Error("unauthorized — check the token / login");
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      onState("connected");
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
      onState("reconnecting", (err as Error).message);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

// --- The executor (the laptop half of remote execution) --------------------------------

export interface RpcRequest {
  id: string;
  kind: "exec" | "read" | "write";
  cmd?: string;
  timeoutMs?: number;
  path?: string;
  content?: string;
}

export interface ExecutorCallbacks {
  // Ask the human. Only called for prompt/danger verdicts; "always" is offered only for
  // plain prompts (never for the denylist). A renderer without a way to ask returns "no".
  confirm: (cmd: string, danger: boolean, allowAlways: boolean) => Promise<"yes" | "no" | "always">;
  // One line of executor activity for the transcript ("[exec] npm test", refusals, …).
  output: (line: string) => void;
}

export interface ExecutorOptions {
  session: RemoteSession;
  workspace: string;
  yolo: boolean;
  callbacks: ExecutorCallbacks;
  onState?: (state: "connected" | "reconnecting", detail?: string) => void;
}

// Runs forever: consumes /rpc/stream, executes requests in the workspace, POSTs results.
export function startExecutor(opts: ExecutorOptions): void {
  const { session, workspace, callbacks } = opts;
  let allowlist = loadAllowlist();

  async function handleRequest(reqObj: RpcRequest): Promise<Record<string, unknown>> {
    if (reqObj.kind === "read") {
      try {
        const p = confineToWorkspace(workspace, String(reqObj.path ?? ""));
        callbacks.output(`[read] ${p}`);
        return { id: reqObj.id, ok: true, content: fs.readFileSync(p, "utf8") };
      } catch (err) {
        return { id: reqObj.id, ok: false, error: (err as Error).message };
      }
    }
    if (reqObj.kind === "write") {
      try {
        const p = confineToWorkspace(workspace, String(reqObj.path ?? ""));
        callbacks.output(`[write] ${p} (${String(reqObj.content ?? "").length} chars)`);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, String(reqObj.content ?? ""), "utf8");
        audit({ kind: "write", path: p });
        return { id: reqObj.id, ok: true };
      } catch (err) {
        return { id: reqObj.id, ok: false, error: (err as Error).message };
      }
    }
    const cmd = String(reqObj.cmd ?? "");
    const verdict = evaluateCommand(cmd, allowlist, opts.yolo);
    if (verdict !== "auto") {
      const answer = await callbacks.confirm(cmd, verdict === "danger-prompt", verdict === "prompt");
      if (answer === "always" && verdict === "prompt") {
        allowlist = [...allowlist, allowPrefixFor(cmd)];
        saveAllowlist(allowlist);
      } else if (answer !== "yes" && answer !== "always") {
        audit({ kind: "exec", cmd, refused: true });
        callbacks.output(`[refused] ${cmd}`);
        return { id: reqObj.id, ok: false, error: "the user declined to run this command" };
      }
    }
    callbacks.output(`[exec] ${cmd}`);
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

  void consumeSse(
    session,
    `/rpc/stream?externalUserId=${encodeURIComponent(session.externalUserId)}&workspace=${encodeURIComponent(workspace)}${session.authQuery}`,
    (event, data) => {
      if (event !== "request") return;
      let reqObj: RpcRequest;
      try {
        reqObj = JSON.parse(data) as RpcRequest;
      } catch {
        return;
      }
      void handleRequest(reqObj).then((result) =>
        fetch(`${session.base}/rpc/result?externalUserId=${encodeURIComponent(session.externalUserId)}`, {
          method: "POST",
          headers: session.headers(),
          body: JSON.stringify(result),
        }).catch((err) => log.warn({ err: (err as Error).message }, "remote: result POST failed")),
      );
    },
    opts.onState ?? (() => {}),
  );
}

// --- Server data fetchers (the slash-command views) -------------------------------------

async function getJson<T>(session: RemoteSession, p: string): Promise<T | null> {
  try {
    const res = await fetch(
      `${session.base}${p}${p.includes("?") ? "&" : "?"}externalUserId=${encodeURIComponent(session.externalUserId)}`,
      { headers: session.headers() },
    );
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export const fetchers = {
  agents: (s: RemoteSession) => getJson<{ agents: Array<Record<string, unknown>> }>(s, "/agents"),
  schedules: (s: RemoteSession) => getJson<{ static: Array<Record<string, unknown>>; dynamic: Array<Record<string, unknown>> }>(s, "/schedules"),
  activity: (s: RemoteSession) => getJson<{ turns: Array<Record<string, unknown>> }>(s, "/activity"),
  skills: (s: RemoteSession) => getJson<{ skills: Array<Record<string, unknown>>; pending: Array<Record<string, unknown>> }>(s, "/skills"),
  status: (s: RemoteSession) => getJson<Record<string, unknown>>(s, "/status"),
  conversations: (s: RemoteSession) => getJson<{ conversations: Array<Record<string, unknown>>; defaultId: string }>(s, "/conversations"),
};

export async function sendMessage(
  session: RemoteSession,
  text: string,
  execution: "local" | "server",
  conversationId?: string,
): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${session.base}/messages`, {
    method: "POST",
    headers: session.headers(),
    body: JSON.stringify({
      externalUserId: session.externalUserId,
      text,
      execution,
      ...(conversationId ? { conversationId } : {}),
    }),
  });
  return { ok: res.ok, status: res.status };
}

export async function abortTurn(session: RemoteSession, conversationId?: string): Promise<boolean> {
  try {
    const res = await fetch(`${session.base}/abort`, {
      method: "POST",
      headers: session.headers(),
      body: JSON.stringify({
        externalUserId: session.externalUserId,
        ...(conversationId ? { conversationId } : {}),
      }),
    });
    if (!res.ok) return false;
    const j = (await res.json()) as { stopped?: boolean };
    return Boolean(j.stopped);
  } catch {
    return false;
  }
}
