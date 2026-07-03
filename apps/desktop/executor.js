// The desktop app's embedded EXECUTOR — the same role as `dae remote`: consume the
// server's /rpc/stream, run exec/read/write requests in the configured workspace, POST
// results back. Confirmations are native dialogs.
//
// Self-contained CJS (the shell doesn't depend on the daedalus package). The policy —
// denylist, two-token allowlist prefixes, workspace confinement — MIRRORS
// src/cli/remote-shared.ts, which is the source of truth; keep them in sync. The
// allowlist and audit log are the SAME files the CLI uses (~/.daedalus/), so an
// "always allow" granted in either surface applies to both.

const { dialog } = require("electron");
const { exec: childExec } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ALLOW_FILE = path.join(os.homedir(), ".daedalus", "remote-allow.json");
const AUDIT_FILE = path.join(os.homedir(), ".daedalus", "remote-exec.log");
const OUTPUT_CAP = 200_000;

// Never auto-approved, even in free-rein mode (mirrors remote-shared.ts).
const DENYLIST = [
  /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\b/i,
  /\bsudo\b/i,
  /\bmkfs\b/i,
  /\bdd\b[^|;&]*\bof=\/dev\//i,
  /\b(shutdown|reboot|halt)\b/i,
  /\bchmod\s+[0-7]*\s+\/(\s|$)/,
  />\s*\/dev\/sd[a-z]\b/i,
];

function evaluateCommand(cmd, allowlist, yolo) {
  const trimmed = cmd.trim();
  if (DENYLIST.some((re) => re.test(trimmed))) return "danger-prompt";
  if (yolo) return "auto";
  if (allowlist.some((prefix) => prefix && trimmed.startsWith(prefix))) return "auto";
  return "prompt";
}

function allowPrefixFor(cmd) {
  return cmd.trim().split(/\s+/).slice(0, 2).join(" ");
}

function confineToWorkspace(workspace, requested) {
  const root = path.resolve(workspace);
  const resolved = path.resolve(root, requested);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path '${requested}' is outside the workspace (${root})`);
  }
  return resolved;
}

function loadAllowlist() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ALLOW_FILE, "utf8"));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function saveAllowlist(list) {
  try {
    fs.mkdirSync(path.dirname(ALLOW_FILE), { recursive: true });
    fs.writeFileSync(ALLOW_FILE, JSON.stringify([...new Set(list)].sort(), null, 2));
  } catch {
    /* best-effort */
  }
}

function audit(entry) {
  try {
    fs.mkdirSync(path.dirname(AUDIT_FILE), { recursive: true });
    fs.appendFileSync(AUDIT_FILE, JSON.stringify({ ts: new Date().toISOString(), source: "desktop", ...entry }) + "\n");
  } catch {
    /* auditing must never block execution */
  }
}

// One running executor per app. start() replaces any previous instance.
let current = null;

/**
 * @param {object} opts
 * @param {string} opts.serverUrl
 * @param {string} opts.workspace
 * @param {"ask"|"yolo"} opts.approval
 * @param {() => Promise<{headers: Record<string,string>, externalUserId: string|null}>} opts.getAuth
 *   Auth borrowed from the window: the login session cookie and/or the web UI's stored
 *   uid + token (login mode needs no externalUserId — the cookie IS the identity).
 * @param {(state: string) => void} opts.onState  "connected" | "reconnecting" | "stopped"
 * @param {Electron.BrowserWindow} opts.parentWindow  dialog anchor
 */
function start(opts) {
  stop();
  const controller = new AbortController();
  const me = { controller, stopped: false };
  current = me;
  void runLoop(opts, me);
  return me;
}

function stop() {
  if (current) {
    current.stopped = true;
    current.controller.abort();
    current = null;
  }
}

function isRunning() {
  return current !== null;
}

async function runLoop(opts, me) {
  const base = opts.serverUrl.replace(/\/$/, "");
  while (!me.stopped) {
    try {
      const auth = await opts.getAuth();
      const qs = new URLSearchParams();
      if (auth.externalUserId) qs.set("externalUserId", auth.externalUserId);
      qs.set("workspace", opts.workspace);
      // Machine description for the turn's execution-environment context line.
      qs.set("hostname", os.hostname().split(".")[0] || "");
      qs.set("platform", os.platform());
      qs.set("arch", os.arch());
      const res = await fetch(`${base}/rpc/stream?${qs}`, {
        headers: auth.headers,
        signal: me.controller.signal,
      });
      if (res.status === 401) throw new Error("unauthorized (sign in first)");
      if (res.status === 404) throw new Error("remote execution is not enabled on the server");
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      opts.onState("connected");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let sep;
        while ((sep = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, sep);
          buf = buf.slice(sep + 2);
          if (!block.includes("event: request")) continue;
          const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
          if (!dataLine) continue;
          let reqObj;
          try {
            reqObj = JSON.parse(dataLine.slice(5));
          } catch {
            continue;
          }
          void handleRequest(opts, reqObj).then((result) =>
            fetch(`${base}/rpc/result?${auth.externalUserId ? `externalUserId=${encodeURIComponent(auth.externalUserId)}` : ""}`, {
              method: "POST",
              headers: { ...auth.headers, "content-type": "application/json" },
              body: JSON.stringify(result),
            }).catch(() => {}),
          );
        }
      }
      throw new Error("stream ended");
    } catch (err) {
      if (me.stopped) break;
      opts.onState("reconnecting");
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  opts.onState("stopped");
}

async function handleRequest(opts, reqObj) {
  if (reqObj.kind === "read") {
    try {
      const p = confineToWorkspace(opts.workspace, String(reqObj.path ?? ""));
      return { id: reqObj.id, ok: true, content: fs.readFileSync(p, "utf8") };
    } catch (err) {
      return { id: reqObj.id, ok: false, error: err.message };
    }
  }
  if (reqObj.kind === "write") {
    try {
      const p = confineToWorkspace(opts.workspace, String(reqObj.path ?? ""));
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, String(reqObj.content ?? ""), "utf8");
      audit({ kind: "write", path: p });
      return { id: reqObj.id, ok: true };
    } catch (err) {
      return { id: reqObj.id, ok: false, error: err.message };
    }
  }
  const cmd = String(reqObj.cmd ?? "");
  let allowlist = loadAllowlist();
  const verdict = evaluateCommand(cmd, allowlist, opts.approval === "yolo");
  if (verdict !== "auto") {
    const danger = verdict === "danger-prompt";
    const buttons = danger ? ["Deny", "Allow once"] : ["Deny", "Allow once", "Always allow prefix"];
    const { response } = await dialog.showMessageBox(opts.parentWindow, {
      type: danger ? "warning" : "question",
      message: danger ? "The agent wants to run a DANGEROUS command" : "The agent wants to run a command",
      detail: `${cmd}\n\nWorkspace: ${opts.workspace}`,
      buttons,
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 0) {
      audit({ kind: "exec", cmd, refused: true });
      return { id: reqObj.id, ok: false, error: "the user declined to run this command" };
    }
    if (response === 2 && !danger) {
      allowlist = [...allowlist, allowPrefixFor(cmd)];
      saveAllowlist(allowlist);
    }
  }
  const timeoutMs = Math.min(reqObj.timeoutMs ?? 120_000, 10 * 60_000);
  const started = Date.now();
  return new Promise((resolve) => {
    childExec(cmd, { cwd: opts.workspace, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      const timedOut = Boolean(err && err.killed);
      const exitCode = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      audit({ kind: "exec", cmd, exitCode, timedOut, durationMs: Date.now() - started });
      resolve({
        id: reqObj.id,
        ok: exitCode === 0,
        stdout: String(stdout).slice(0, OUTPUT_CAP),
        stderr: String(stderr).slice(0, OUTPUT_CAP),
        exitCode,
        timedOut,
      });
    });
  });
}

module.exports = { start, stop, isRunning, evaluateCommand, allowPrefixFor, confineToWorkspace };
