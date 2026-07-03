// Smoke test for remote execution (`dae remote`): the /rpc bridge on the web channel,
// RemoteRuntime end-to-end over real HTTP, and the client's command policy + workspace
// confinement. A scripted executor stands in for the laptop-side client.

import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebChannel } from "../dist/channels/web.js";
import { SessionStore } from "../dist/sessions/store.js";
import { getRpcToken } from "../dist/channels/remote-exec.js";
import { RemoteRuntime } from "../dist/runtime/remote.js";
import {
  evaluateCommand,
  allowPrefixFor,
  confineToWorkspace,
} from "../dist/cli/remote-client.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const dir = mkdtempSync(join(tmpdir(), "dae-smoke-remote-"));
const workspace = mkdtempSync(join(tmpdir(), "dae-smoke-ws-"));
const sessions = new SessionStore(join(dir, "sessions.sqlite"));
const PORT = 18791;
const base = `http://127.0.0.1:${PORT}`;
const UID = "laptop-user";

const chan = new WebChannel({
  defaultAgent: "artemis",
  port: PORT,
  sessions,
  heartbeatMs: 60_000,
  remoteExec: { enabled: true, timeoutMs: 5_000 },
});
await chan.start({ publish: async () => {} });

// --- Scripted executor: consume /rpc/stream, answer requests like the real client ---
const seen = [];
const executorAbort = new AbortController();
async function runExecutor() {
  const res = await fetch(`${base}/rpc/stream?externalUserId=${UID}&workspace=${encodeURIComponent(workspace)}`, {
    signal: executorAbort.signal,
  });
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
      const req = JSON.parse(dataLine.slice(5));
      seen.push(req);
      let result;
      if (req.kind === "exec") {
        if (req.cmd === "sleep-forever") continue; // let the server-side timeout fire
        result = { id: req.id, ok: true, stdout: `ran:${req.cmd}`, stderr: "", exitCode: 0, timedOut: false };
      } else if (req.kind === "read") {
        try {
          result = { id: req.id, ok: true, content: readFileSync(join(workspace, req.path), "utf8") };
        } catch (e) {
          result = { id: req.id, ok: false, error: e.message };
        }
      } else {
        writeFileSync(join(workspace, req.path), req.content ?? "");
        result = { id: req.id, ok: true };
      }
      await fetch(`${base}/rpc/result?externalUserId=${UID}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(result),
      });
    }
  }
}
const executorDone = runExecutor().catch(() => {});
await new Promise((r) => setTimeout(r, 300)); // let registration land

const token = getRpcToken();
const rpcExec = (body) =>
  fetch(`${base}/rpc/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dae-rpc-token": token },
    body: JSON.stringify({ userId: sessions.resolveUser("web", UID), ...body }),
  }).then((r) => r.json());

// --- 1. Bridge auth + roundtrips ---
{
  const noToken = await fetch(`${base}/rpc/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  expect("bridge refuses without the rpc token", noToken.status === 401);

  const r = await rpcExec({ kind: "exec", cmd: "echo hello", timeoutMs: 3_000 });
  expect("exec roundtrip via the bridge", r.ok === true && r.stdout === "ran:echo hello", JSON.stringify(r));

  const w = await rpcExec({ kind: "write", path: "note.txt", content: "from the server" });
  expect("write roundtrip", w.ok === true);
  const rd = await rpcExec({ kind: "read", path: "note.txt" });
  expect("read roundtrip returns what was written", rd.ok === true && rd.content === "from the server");

  const timedOut = await rpcExec({ kind: "exec", cmd: "sleep-forever", timeoutMs: 400 });
  expect("unanswered request times out with an error result", timedOut.ok === false && Boolean(timedOut.error), JSON.stringify(timedOut));

  const nobody = await fetch(`${base}/rpc/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-dae-rpc-token": token },
    body: JSON.stringify({ userId: "no-such-user", kind: "exec", cmd: "echo hi" }),
  }).then((r) => r.json());
  expect("no executor connected → immediate helpful error", nobody.ok === false && /no executor/.test(nobody.error ?? ""));
}

// --- 2. RemoteRuntime end-to-end over the live bridge ---
{
  const runtime = new RemoteRuntime({ url: base, token, userId: sessions.resolveUser("web", UID) });
  expect("RemoteRuntime id is 'remote'", runtime.id === "remote");
  const res = await runtime.exec("git status", { timeoutMs: 3_000 });
  expect("RemoteRuntime.exec returns ExecResult", res.exitCode === 0 && res.stdout === "ran:git status", JSON.stringify(res));
  await runtime.writeFile("rt.txt", "runtime write");
  const back = await runtime.readFile("rt.txt");
  expect("RemoteRuntime read/write file ops", back === "runtime write");
  let threw = false;
  try {
    await runtime.readFile("missing-file.txt");
  } catch {
    threw = true;
  }
  expect("RemoteRuntime.readFile throws on executor error", threw);
}

// --- 3. Command policy (the client's confirm gate) ---
{
  expect("plain command prompts by default", evaluateCommand("git status", [], false) === "prompt");
  expect("allowlisted prefix auto-approves", evaluateCommand("git status --short", ["git status"], false) === "auto");
  expect("yolo auto-approves normal commands", evaluateCommand("npm test", [], true) === "auto");
  expect("rm -rf always danger-prompts, even yolo", evaluateCommand("rm -rf /tmp/x", [], true) === "danger-prompt");
  expect("sudo always danger-prompts", evaluateCommand("sudo apt install x", ["sudo"], true) === "danger-prompt");
  expect("allow prefix is the first two tokens", allowPrefixFor("git status --short -b") === "git status");
}

// --- 4. Workspace confinement ---
{
  const inWs = confineToWorkspace(workspace, "sub/dir/file.txt");
  expect("relative paths resolve inside the workspace", inWs.startsWith(workspace));
  let threw = false;
  try {
    confineToWorkspace(workspace, "../../etc/passwd");
  } catch {
    threw = true;
  }
  expect("escape attempts are refused", threw);
  let threwAbs = false;
  try {
    confineToWorkspace(workspace, "/etc/passwd");
  } catch {
    threwAbs = true;
  }
  expect("absolute paths outside the workspace are refused", threwAbs);
}

// --- 5. remoteConnected + executor replacement ---
{
  const userId = sessions.resolveUser("web", UID);
  expect("remoteConnected(userId) is true while the executor is up", chan.remoteConnected(userId) === true);
  executorAbort.abort();
  await executorDone;
  await new Promise((r) => setTimeout(r, 200));
  expect("remoteConnected flips false after disconnect", chan.remoteConnected(userId) === false);
}

await chan.stop();
sessions.close();
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
