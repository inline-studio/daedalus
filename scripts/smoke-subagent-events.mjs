// Smoke test for live subagent event streaming (the "sub-agent view" plumbing).
//
// Covers the three layers without a docker daemon or a live LLM:
//   - spawn_subagent wraps the subagent's turn events with an origin (path + spawnId)
//     and brackets them with subagent_start / subagent_end
//   - the container hop: sentinel-framed event lines parse + forward correctly, and
//     the dispatcher only asks for the stream when it has a live sink
//   - the channel sinks: web maps origin-tagged events to `subagent` SSE events (and
//     never leaks subagent deltas into the top-level bubble); the CLI prints prefixed
//     summary lines per its verbosity setting

import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSpawnSubagentTool } from "../dist/kernel/orchestrator.js";
import {
  buildContainerArgs,
  forwardEventLines,
  parseEventLine,
} from "../dist/dispatch/container.js";
import { DISPATCH_EVENT_SENTINEL } from "../dist/dispatch/base.js";
import { WebChannel } from "../dist/channels/web.js";
import { CliChannel } from "../dist/channels/cli.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// --- 1. parseEventLine: sentinel framing ---
{
  const ev = parseEventLine(DISPATCH_EVENT_SENTINEL + JSON.stringify({ type: "tool_use", id: "t", name: "bash", input: {} }));
  expect("parseEventLine parses a sentinel-framed event", ev?.type === "tool_use" && ev?.name === "bash");
  expect("parseEventLine handles a noise prefix on the same line", parseEventLine("startup noise " + DISPATCH_EVENT_SENTINEL + '{"type":"turn_start","turn":1}')?.type === "turn_start");
  expect("parseEventLine ignores plain lines", parseEventLine("just some log output") === null);
  expect("parseEventLine ignores sentinel with bad JSON", parseEventLine(DISPATCH_EVENT_SENTINEL + "{nope") === null);
  expect("parseEventLine ignores sentinel with a non-event payload", parseEventLine(DISPATCH_EVENT_SENTINEL + '"hello"') === null);
}

// --- 2. forwardEventLines: streams events, skips noise, contains a throwing sink ---
{
  const got = [];
  const stream = new PassThrough();
  let threwOnce = false;
  forwardEventLines(stream, (ev) => {
    if (!threwOnce) {
      threwOnce = true;
      got.push(ev);
      throw new Error("renderer bug");
    }
    got.push(ev);
  });
  stream.write("bootstrap noise\n");
  stream.write(DISPATCH_EVENT_SENTINEL + '{"type":"turn_start","turn":1}\n');
  stream.write("more noise\n" + DISPATCH_EVENT_SENTINEL + '{"type":"tool_running","id":"t1","name":"bash"}\n');
  stream.end();
  await new Promise((r) => setTimeout(r, 20));
  expect(
    "forwardEventLines forwards both events in order despite a throwing sink",
    got.length === 2 && got[0].type === "turn_start" && got[1].type === "tool_running",
    `got ${JSON.stringify(got)}`,
  );
}

// --- 3. buildContainerArgs: DAE_EVENT_STREAM only when streaming is requested ---
{
  const opts = {
    defaultImage: "ghcr.io/test/daedalus:test",
    network: "daedalus",
    hostBrainPath: "/host/brain",
    hostSharedPath: "/host/shared",
    hostDataPath: "/host/data",
    hostConfigDir: "/host/etc",
  };
  const base = {
    containerName: "dae-ev",
    image: "ghcr.io/test/daedalus:test",
    dispatchArgs: { agentName: "helper", sessionId: "s", userId: "u", isSubagent: true },
    opts,
    brainWritable: false,
    mountDockerSock: false,
    limits: { memory: "1g", cpus: "1", pidsLimit: 512 },
  };
  const withStream = buildContainerArgs({ ...base, streamEvents: true });
  const withoutStream = buildContainerArgs({ ...base });
  expect(
    "streamEvents:true sets -e DAE_EVENT_STREAM=ndjson",
    withStream.some((v, i) => withStream[i - 1] === "-e" && v === "DAE_EVENT_STREAM=ndjson"),
  );
  expect(
    "no streamEvents → no DAE_EVENT_STREAM env",
    !withoutStream.some((v) => v.startsWith("DAE_EVENT_STREAM")),
  );
}

// --- 4. spawn_subagent origin wrapping ---
// A tmp brain with one subagent so loadAgent resolves it.
const brain = mkdtempSync(join(tmpdir(), "dae-smoke-brain-"));
mkdirSync(join(brain, "agents"), { recursive: true });
writeFileSync(
  join(brain, "agents", "helper.md"),
  "---\nprovider: openai\nmodel: gpt-test\n---\nHelper body\n",
);
const stubSessions = {
  getOrCreateSession: () => ({ id: "sub-sess" }),
  tail: () => [],
  appendMessage: () => {},
};
const parent = { name: "orchestrator", subagents: ["helper"] };
const config = { brain: { path: brain, writable: false } };

{
  const events = [];
  const dispatcher = {
    id: "stub",
    streaming: true,
    dispatch: async (args) => {
      // The subagent's own event (no origin) and a nested, already-tagged one.
      args.onEvent?.({ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } });
      args.onEvent?.({
        type: "tool_use",
        id: "t2",
        name: "read",
        input: {},
        origin: { path: ["nested"], spawnId: "inner" },
      });
      return { status: "complete", finalText: "done", turns: 1 };
    },
  };
  const tool = await buildSpawnSubagentTool({
    config,
    parent,
    sessions: stubSessions,
    userId: "u1",
    dispatcher,
    onEvent: (ev) => events.push(ev),
  });
  const result = await tool.invoke({ agent: "helper", prompt: "do a thing" }, {});
  expect("spawn returns the subagent result", result.content === "RESULT: done");
  expect(
    "subagent_start emitted first with origin path + prompt",
    events[0]?.type === "subagent_start" && events[0].prompt === "do a thing" &&
      JSON.stringify(events[0].origin?.path) === '["helper"]',
    JSON.stringify(events[0]),
  );
  const spawnId = events[0]?.origin?.spawnId;
  expect("spawnId assigned", typeof spawnId === "string" && spawnId.length > 0);
  expect(
    "subagent's own event re-tagged with origin",
    events[1]?.type === "tool_use" && JSON.stringify(events[1].origin?.path) === '["helper"]' &&
      events[1].origin?.spawnId === spawnId,
    JSON.stringify(events[1]),
  );
  expect(
    "nested event path prepended + spawnId overwritten (groups under the top-level spawn)",
    JSON.stringify(events[2]?.origin?.path) === '["helper","nested"]' &&
      events[2]?.origin?.spawnId === spawnId,
    JSON.stringify(events[2]),
  );
  expect(
    "subagent_end carries the dispatch status + same spawnId",
    events[3]?.type === "subagent_end" && events[3].status === "complete" &&
      events[3].origin?.spawnId === spawnId,
    JSON.stringify(events[3]),
  );
}

// 4b. Dispatch failure → subagent_end status "error", and the throw propagates.
{
  const events = [];
  const dispatcher = {
    id: "stub",
    dispatch: async () => {
      throw new Error("container exploded");
    },
  };
  const tool = await buildSpawnSubagentTool({
    config,
    parent,
    sessions: stubSessions,
    userId: "u1",
    dispatcher,
    onEvent: (ev) => events.push(ev),
  });
  let threw = false;
  try {
    await tool.invoke({ agent: "helper", prompt: "boom" }, {});
  } catch {
    threw = true;
  }
  const last = events[events.length - 1];
  expect("dispatch failure still throws", threw);
  expect(
    "dispatch failure emits subagent_end status=error",
    last?.type === "subagent_end" && last.status === "error",
    JSON.stringify(last),
  );
}

// 4c. No sink → dispatch args carry no onEvent, tool still works.
{
  let sawOnEvent = "unset";
  const dispatcher = {
    id: "stub",
    dispatch: async (args) => {
      sawOnEvent = typeof args.onEvent;
      return { status: "complete", finalText: "quiet", turns: 1 };
    },
  };
  const tool = await buildSpawnSubagentTool({
    config,
    parent,
    sessions: stubSessions,
    userId: "u1",
    dispatcher,
  });
  const result = await tool.invoke({ agent: "helper", prompt: "hush" }, {});
  expect("no parent sink → no onEvent passed to dispatch", sawOnEvent === "undefined");
  expect("tool still returns the result without a sink", result.content === "RESULT: quiet");
}

// --- 5. Web streamSink: origin-tagged events → `subagent` SSE, never the top-level kinds ---
{
  const chan = new WebChannel({ defaultAgent: "orchestrator" });
  const chunks = [];
  // Register a fake live SSE connection under the legacy bare-user key.
  chan["streams"].set("u1", new Set([{ write: (s) => chunks.push(s) }]));
  const sink = chan.streamSink("u1");
  const origin = { path: ["helper"], spawnId: "sp1" };
  sink({ type: "subagent_start", prompt: "task", origin });
  sink({ type: "text_delta", text: "SECRET-DELTA", origin }); // must be dropped
  sink({ type: "tool_use", id: "t1", name: "bash", input: { command: "ls" }, origin });
  sink({ type: "tool_result", id: "t1", name: "bash", isError: false, origin });
  sink({ type: "subagent_end", status: "complete", origin });
  sink({ type: "text_delta", text: "top-level" }); // top-level stays on `delta`
  const all = chunks.join("");
  const subagentBlocks = chunks.filter((c) => c.startsWith("event: subagent\n"));
  expect("web: 4 subagent SSE events (start/tool/tool_done/end)", subagentBlocks.length === 4, `got ${subagentBlocks.length}`);
  expect("web: subagent deltas are dropped", !all.includes("SECRET-DELTA"));
  expect(
    "web: subagent tool never emitted as a top-level `tool` event",
    !chunks.some((c) => c.startsWith("event: tool\n")),
  );
  expect("web: top-level delta still flows", chunks.some((c) => c.startsWith("event: delta\n") && c.includes("top-level")));
  expect(
    "web: subagent payload carries spawnId + path",
    subagentBlocks[0].includes('"spawnId":"sp1"') && subagentBlocks[0].includes('"path":["helper"]'),
    subagentBlocks[0],
  );
}

// --- 6. CLI sink: prefixed summary lines; verbosity honored ---
{
  const capture = () => {
    const out = [];
    const orig = process.stdout.write.bind(process.stdout);
    process.stdout.write = (s) => {
      out.push(String(s));
      return true;
    };
    return { out, restore: () => (process.stdout.write = orig) };
  };
  const origin = { path: ["helper"], spawnId: "sp1" };

  const summary = new CliChannel({ defaultAgent: "o", subagentEvents: "summary" });
  let cap = capture();
  try {
    const sink = summary.streamSink();
    sink({ type: "subagent_start", prompt: "long   task", origin });
    sink({ type: "text_delta", text: "SECRET", origin });
    sink({ type: "tool_use", id: "t1", name: "bash", input: {}, origin });
    sink({ type: "turn_complete", finalText: "sub reply", origin });
    sink({ type: "subagent_end", status: "complete", origin });
  } finally {
    cap.restore();
  }
  let text = cap.out.join("");
  expect("cli summary: start line prefixed with [helper]", text.includes("[helper] ⚙ started: long task"));
  expect("cli summary: tool line present", text.includes("[helper] tool: bash"));
  expect("cli summary: done line present", text.includes("[helper] done"));
  expect("cli summary: subagent deltas not printed", !text.includes("SECRET"));
  expect("cli summary: subagent reply not printed at summary level", !text.includes("sub reply"));

  const full = new CliChannel({ defaultAgent: "o", subagentEvents: "full" });
  cap = capture();
  try {
    full.streamSink()({ type: "turn_complete", finalText: "sub reply", origin });
  } finally {
    cap.restore();
  }
  expect("cli full: subagent reply printed", cap.out.join("").includes("[helper] reply: sub reply"));

  const off = new CliChannel({ defaultAgent: "o", subagentEvents: "off" });
  cap = capture();
  try {
    const sink = off.streamSink();
    sink({ type: "subagent_start", prompt: "task", origin });
    sink({ type: "tool_use", id: "t1", name: "bash", input: {}, origin });
  } finally {
    cap.restore();
  }
  expect("cli off: nothing printed for subagent events", cap.out.join("") === "");
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
