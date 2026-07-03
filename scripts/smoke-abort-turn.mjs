// Smoke test for stop/abort (WS6a): the kernel's between-tools abort check, the web
// channel's POST /abort route (ownership + wiring), and the persistent dispatcher's
// abort forward to the worker.

import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kernel } from "../dist/kernel/agent.js";
import { WebChannel } from "../dist/channels/web.js";
import { SessionStore } from "../dist/sessions/store.js";
import { PersistentContainerDispatcher } from "../dist/dispatch/persistent.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// --- 1. Kernel: abort lands BETWEEN tool executions ---
{
  // One completion returns two tool calls; the abort fires while the first runs. The
  // kernel must throw AbortError before executing the second.
  const executed = [];
  const controller = new AbortController();
  const provider = {
    id: "fake",
    capabilities: { tools: true, streaming: false, vision: false, systemPromptAsField: true },
    async complete() {
      return {
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "t1", name: "wait", input: { n: 1 } },
            { type: "tool_use", id: "t2", name: "wait", input: { n: 2 } },
          ],
        },
        stopReason: "tool_use",
      };
    },
  };
  const waitTool = {
    definition: { name: "wait", description: "wait a moment", inputSchema: { type: "object", properties: {} } },
    async invoke(input) {
      executed.push(input.n);
      controller.abort(); // the user hits Stop while tool 1 runs
      await new Promise((r) => setTimeout(r, 50));
      return { content: "done" };
    },
  };
  const kernel = new Kernel({
    provider,
    model: "fake",
    system: "test",
    builtinTools: [waitTool],
    mcpServers: new Map(),
    toolContext: { runtime: { id: "host", exec: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }) }, brainPath: "/tmp", brainWritable: false, workspacePath: "/tmp", agentName: "t" },
    maxTurns: 5,
    maxTokens: 128,
  });
  let threw = null;
  try {
    await kernel.runWithMessages(
      [{ role: "user", content: [{ type: "text", text: "go" }] }],
      controller.signal,
    );
  } catch (err) {
    threw = err;
  }
  expect("kernel throws AbortError on stop", threw?.name === "AbortError", String(threw));
  expect("second tool never executed", executed.length === 1, JSON.stringify(executed));
}

// --- 2. Web channel: POST /abort (ownership + wiring) ---
{
  const dir = mkdtempSync(join(tmpdir(), "dae-smoke-abort-"));
  const sessions = new SessionStore(join(dir, "sessions.sqlite"));
  const PORT = 18792;
  const aborted = [];
  const chan = new WebChannel({
    defaultAgent: "artemis",
    port: PORT,
    sessions,
    heartbeatMs: 60_000,
    abortTurn: async (conversationId) => {
      aborted.push(conversationId);
      return true;
    },
  });
  await chan.start({ publish: async () => {} });
  const base = `http://127.0.0.1:${PORT}`;

  // The user's own conversation aborts…
  const list = await fetch(`${base}/conversations?externalUserId=u1`).then((r) => r.json());
  const r1 = await fetch(`${base}/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ externalUserId: "u1", conversationId: list.defaultId }),
  }).then((r) => r.json());
  expect("POST /abort stops the user's own conversation", r1.stopped === true && aborted[0] === list.defaultId);

  // …someone else's conversation id falls back to the CALLER's default session, so the
  // foreign turn is untouched (ownership enforced by resolveConversation).
  const r2 = await fetch(`${base}/abort`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ externalUserId: "attacker", conversationId: list.defaultId }),
  }).then((r) => r.json());
  const attackerDefault = aborted[1];
  expect(
    "a foreign conversationId cannot abort another user's turn",
    r2.stopped === true && attackerDefault !== list.defaultId,
    JSON.stringify(aborted),
  );
  await chan.stop();
  sessions.close();
}

// --- 3. Persistent dispatcher: abort forwards to the worker ---
{
  const hits = [];
  const worker = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      hits.push({ url: req.url, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ aborted: true }));
    });
  });
  await new Promise((r) => worker.listen(18793, r));
  process.env.DAE_WORKER_URL = "http://127.0.0.1:18793";
  const d = new PersistentContainerDispatcher({});
  const ok = await d.abort("sess-42");
  expect(
    "persistent dispatcher forwards abort to the worker",
    ok === true && hits[0]?.url === "/abort" && hits[0].body.includes("sess-42"),
    JSON.stringify(hits),
  );
  delete process.env.DAE_WORKER_URL;
  worker.close();
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
