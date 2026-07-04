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

// --- 2b. The bridge call bypasses the global undici dispatcher ---
// The worker / agent containers install OneCLI's MITM ProxyAgent process-wide; the
// /rpc/exec fetch must not ride it (casa, 2026-07: every local-exec tool call died with
// "bridge unreachable" and never reached the executor). Point the global dispatcher at a
// dead proxy and prove RemoteRuntime's POST still reaches a bridge server. (A canned
// bridge, not the live one — the scripted executor above shares this process, so the
// hostile dispatcher would break IT, not just the code under test.)
{
  const http = await import("node:http");
  const { ProxyAgent, Agent, setGlobalDispatcher } = await import("undici");
  const hits = [];
  const bridge = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "x", ok: true, stdout: "direct", exitCode: 0 }));
  });
  await new Promise((r) => bridge.listen(18797, r));
  setGlobalDispatcher(new ProxyAgent("http://127.0.0.1:1"));
  try {
    const runtime = new RemoteRuntime({ url: "http://127.0.0.1:18797", token: "t", userId: "u" });
    const res = await runtime.exec("echo hi", { timeoutMs: 3_000 });
    expect(
      "RemoteRuntime bypasses a hostile global dispatcher (OneCLI MITM)",
      res.exitCode === 0 && res.stdout === "direct" && hits.length === 1,
      JSON.stringify({ res, hits }),
    );
  } finally {
    setGlobalDispatcher(new Agent());
    bridge.close();
  }
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

// --- 5. Environment advertisement (WS7) ---
{
  const userId = sessions.resolveUser("web", UID);
  const info = chan.executorInfo(userId);
  expect(
    "executorInfo carries workspace (env params optional)",
    info !== null && typeof info.workspace === "string",
    JSON.stringify(info),
  );
  // A second scripted executor registering WITH machine params replaces the first and
  // its description becomes visible.
  const abort2 = new AbortController();
  void fetch(
    `${base}/rpc/stream?externalUserId=${UID}&workspace=/tmp/ws2&hostname=scotts-mba&platform=darwin&arch=arm64`,
    { signal: abort2.signal },
  ).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  const info2 = chan.executorInfo(userId);
  expect(
    "hostname/platform/arch registered from the stream params",
    info2?.hostname === "scotts-mba" && info2?.platform === "darwin" && info2?.arch === "arm64",
    JSON.stringify(info2),
  );
  abort2.abort();
  await new Promise((r) => setTimeout(r, 200));
}

// --- 6. Executor placement (WS7): execution: executor frontmatter ---
{
  const { buildSpawnSubagentTool } = await import("../dist/kernel/orchestrator.js");
  const fsp = await import("node:fs/promises");
  const brain = mkdtempSync(join(tmpdir(), "dae-smoke-placement-"));
  await fsp.mkdir(join(brain, "agents"), { recursive: true });
  await fsp.writeFile(
    join(brain, "agents", "host-worker.md"),
    "---\nprovider: openai\nmodel: m\nexecution: executor\n---\nRuns on the host.\n",
  );
  await fsp.writeFile(
    join(brain, "agents", "server-worker.md"),
    "---\nprovider: openai\nmodel: m\n---\nRuns server-side.\n",
  );
  const stubSessions = { getOrCreateSession: () => ({ id: "s" }), tail: () => [], appendMessage: () => {} };
  const grant = { userId: "u1", url: "http://bridge", token: "t", env: { hostname: "mba" } };
  const dispatched = [];
  const dispatcher = {
    id: "stub",
    dispatch: async (args) => {
      dispatched.push(args);
      return { status: "complete", finalText: "ok", turns: 1 };
    },
  };
  const mkTool = (remoteExec) =>
    buildSpawnSubagentTool({
      config: { brain: { path: brain, writable: false } },
      parent: { name: "orchestrator", subagents: ["host-worker", "server-worker"] },
      sessions: stubSessions,
      userId: "u1",
      dispatcher,
      ...(remoteExec ? { remoteExec } : {}),
    });

  const withGrant = await mkTool(grant);
  await withGrant.invoke({ agent: "host-worker", prompt: "go" }, {});
  expect(
    "executor-flagged subagent receives the parent's grant",
    dispatched[0]?.remoteExec?.url === "http://bridge" && dispatched[0]?.remoteExec?.env?.hostname === "mba",
    JSON.stringify(dispatched[0]?.remoteExec),
  );
  await withGrant.invoke({ agent: "server-worker", prompt: "go" }, {});
  expect("unflagged subagent stays server-side", dispatched[1]?.remoteExec === undefined);

  const withoutGrant = await mkTool(undefined);
  const refused = await withoutGrant.invoke({ agent: "host-worker", prompt: "go" }, {});
  expect(
    "executor-flagged spawn without an executor fails fast with guidance",
    refused.isError === true && /dae remote/.test(refused.content),
    refused.content,
  );
  expect("failed placement never dispatched", dispatched.length === 2);
}

// --- 7. remoteConnected lifecycle (self-contained stream; the earlier ones are gone) ---
{
  const userId = sessions.resolveUser("web", UID);
  executorAbort.abort(); // ensure the section-1 executor (already replaced) is fully torn down
  await executorDone;
  const abort3 = new AbortController();
  void fetch(`${base}/rpc/stream?externalUserId=${UID}&workspace=/tmp/ws3`, { signal: abort3.signal }).catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  expect("remoteConnected(userId) is true while an executor is up", chan.remoteConnected(userId) === true);
  abort3.abort();
  await new Promise((r) => setTimeout(r, 200));
  expect("remoteConnected flips false after disconnect", chan.remoteConnected(userId) === false);
}

// --- 7b. Multi-executor: machines coexist; only a SAME-ID reconnect replaces ---
// The normal topology is several machines (CLI ×N + desktop) for one user. Distinct
// executorIds coexist and requests route to the targeted machine; reconnecting with
// the SAME id replaces the zombie predecessor, which is told via `event: replaced`.
{
  const openStream = (executorId, hostname, onEvent) => {
    const abort = new AbortController();
    const done = fetch(
      `${base}/rpc/stream?externalUserId=${UID}&workspace=/tmp/ws-${hostname}&executorId=${executorId}&hostname=${hostname}`,
      { signal: abort.signal },
    )
      .then(async (res) => {
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { done: d, value } = await reader.read();
          if (d) break;
          buf += dec.decode(value, { stream: true });
          let sep;
          while ((sep = buf.indexOf("\n\n")) !== -1) {
            onEvent(buf.slice(0, sep));
            buf = buf.slice(sep + 2);
          }
        }
      })
      .catch(() => {});
    return { abort, done };
  };

  // Two machines, distinct ids → both connected, both listed, requests route by id.
  const aBlocks = [];
  const bBlocks = [];
  const a = openStream("exec-aaa", "mac-one", (b) => aBlocks.push(b));
  const b = openStream("exec-bbb", "mac-two", (ize) => bBlocks.push(ize));
  await new Promise((r) => setTimeout(r, 300));
  const userId = sessions.resolveUser("web", UID);
  expect("two machines coexist (both connected)", chan.remoteConnected(userId, "exec-aaa") && chan.remoteConnected(userId, "exec-bbb"));

  const answer = (blocks, marker) => {
    const reqBlock = blocks.find((x) => x.includes("event: request"));
    if (!reqBlock) return null;
    const req = JSON.parse(reqBlock.split("\n").find((l) => l.startsWith("data:")).slice(5));
    return fetch(`${base}/rpc/result?externalUserId=${UID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: req.id, ok: true, stdout: marker, exitCode: 0 }),
    });
  };
  const rtA = new RemoteRuntime({ url: base, token, userId, executorId: "exec-aaa" });
  const resAP = rtA.exec("hostname", { timeoutMs: 3_000 });
  await new Promise((r) => setTimeout(r, 250));
  await answer(aBlocks, "ran-on-mac-one");
  const resA = await resAP;
  expect("requests route to the TARGETED machine", resA.stdout === "ran-on-mac-one" && bBlocks.every((x) => !x.includes("event: request")), JSON.stringify(resA));

  // Same id reconnects → the old stream is told it was replaced; the other machine is untouched.
  let aSawReplaced = false;
  const a2 = openStream("exec-aaa", "mac-one", (blk) => { if (blk.includes("event: replaced")) aSawReplaced = true; });
  await new Promise((r) => setTimeout(r, 300));
  // aBlocks' stream got the replaced event (check both captures — either listener may have seen it)
  aSawReplaced = aSawReplaced || aBlocks.some((x) => x.includes("event: replaced"));
  expect("a same-id reconnect replaces the zombie (event: replaced)", aSawReplaced);
  expect("the other machine is untouched by the replacement", chan.remoteConnected(userId, "exec-bbb"));

  a2.abort.abort();
  b.abort.abort();
  a.abort.abort();
  await new Promise((r) => setTimeout(r, 200));
}

// --- 8. The REAL startExecutor: creates a missing workspace; spawn failures speak ---
// The wizard only records the workspace path — casa UAT 2026-07: a never-created
// workspace made child_process.exec fail at spawn for EVERY command, as a bare exit 1
// with empty stderr (err.code is the STRING "ENOENT", not a number).
{
  const { startExecutor } = await import("../dist/cli/remote-shared.js");
  const mkSession = (id) => ({
    base,
    externalUserId: id,
    authQuery: "",
    headers: () => ({ "content-type": "application/json" }),
  });

  // (a) Missing workspace → created at startup, commands succeed.
  const missingWs = join(workspace, "nested", "never-made");
  startExecutor({
    session: mkSession("ws-user-a"),
    workspace: missingWs,
    yolo: true,
    callbacks: { output: () => {}, confirm: async () => "yes" },
  });
  await new Promise((r) => setTimeout(r, 300));
  const rtA = new RemoteRuntime({ url: base, token, userId: sessions.resolveUser("web", "ws-user-a") });
  const okRes = await rtA.exec("pwd", { timeoutMs: 3_000 });
  expect(
    "startExecutor creates a missing workspace (exec runs, cwd is the workspace)",
    okRes.exitCode === 0 && okRes.stdout.includes("never-made"),
    JSON.stringify(okRes),
  );

  // (b) Unusable workspace (path is a FILE) → spawn failure surfaces err.message.
  const fileWs = join(workspace, "ws-as-file");
  writeFileSync(fileWs, "not a directory");
  startExecutor({
    session: mkSession("ws-user-b"),
    workspace: fileWs,
    yolo: true,
    callbacks: { output: () => {}, confirm: async () => "yes" },
  });
  await new Promise((r) => setTimeout(r, 300));
  const rtB = new RemoteRuntime({ url: base, token, userId: sessions.resolveUser("web", "ws-user-b") });
  const badRes = await rtB.exec("pwd", { timeoutMs: 3_000 });
  expect(
    "spawn-level failures carry the reason in stderr (not a mute exit 1)",
    badRes.exitCode !== 0 && badRes.stderr.includes("[executor]"),
    JSON.stringify(badRes),
  );
}

await chan.stop();
sessions.close();
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
