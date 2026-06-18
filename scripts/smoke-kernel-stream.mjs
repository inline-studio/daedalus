// Smoke for Phase 1 kernel streaming (event emission):
//  - with an onEvent sink + a streaming provider, the kernel consumes the stream and emits
//    ordered TurnEvents: turn_start → deltas → (tool_use → tool_running → tool_result)* →
//    turn_complete, and still returns the assembled final message/text;
//  - across a tool loop, structural tool events are emitted and the second turn streams too;
//  - WITHOUT a sink, the kernel uses the buffered complete() path and emits nothing (and never
//    calls stream()).

import { Kernel } from "../dist/kernel/agent.js";
import { CliChannel } from "../dist/channels/cli.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const caps = { streaming: true, tools: true, vision: false, systemPromptAsField: true };

// Provider whose stream() replays a scripted async-generator per call.
function streamingProvider(scripts) {
  let i = 0;
  return {
    id: "fake",
    capabilities: caps,
    async complete() {
      throw new Error("complete() should not be called when streaming");
    },
    stream() {
      const fn = scripts[Math.min(i++, scripts.length - 1)];
      return fn();
    },
  };
}

const makeKernel = (provider) =>
  new Kernel({
    provider,
    model: "m",
    system: "s",
    builtinTools: [],
    mcpServers: new Map(),
    toolContext: {},
    maxTurns: 5,
    maxTokens: 4096,
  });

// 1. Single streamed turn: ordered deltas + turn_complete, correct final text.
{
  async function* turn() {
    yield { type: "thinking_delta", text: "hmm " };
    yield { type: "text_delta", text: "hel" };
    yield { type: "text_delta", text: "lo" };
    yield {
      type: "result",
      result: {
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hmm ", signature: "x" },
            { type: "text", text: "hello" },
          ],
        },
        stopReason: "end_turn",
      },
    };
  }
  const events = [];
  const r = await makeKernel(streamingProvider([turn])).run("go", undefined, (e) => events.push(e));
  const types = events.map((e) => e.type);
  expect(
    "order: turn_start → thinking → text*2 → turn_complete",
    JSON.stringify(types) ===
      JSON.stringify(["turn_start", "thinking_delta", "text_delta", "text_delta", "turn_complete"]),
    JSON.stringify(types),
  );
  expect("final text assembled", r.finalText === "hello");
  const tc = events.find((e) => e.type === "turn_complete");
  expect("turn_complete carries final text", tc?.finalText === "hello");
}

// 2. Tool loop: first streamed turn calls a tool, second streams the answer.
{
  async function* toolTurn() {
    yield { type: "tool_use_start", id: "t1", name: "noop" };
    yield { type: "tool_use_input_delta", id: "t1", jsonDelta: '{"a":1}' };
    yield {
      type: "result",
      result: {
        message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "noop", input: { a: 1 } }] },
        stopReason: "tool_use",
      },
    };
  }
  async function* answerTurn() {
    yield { type: "text_delta", text: "done" };
    yield {
      type: "result",
      result: { message: { role: "assistant", content: [{ type: "text", text: "done" }] }, stopReason: "end_turn" },
    };
  }
  const events = [];
  const r = await makeKernel(streamingProvider([toolTurn, answerTurn])).run("go", undefined, (e) =>
    events.push(e),
  );
  const types = events.map((e) => e.type);
  expect("two turn_start events (loop ran twice)", types.filter((t) => t === "turn_start").length === 2);
  expect("tool_use emitted with parsed input", events.some((e) => e.type === "tool_use" && e.input?.a === 1));
  expect("tool_running emitted", types.includes("tool_running"));
  const tr = events.find((e) => e.type === "tool_result");
  // 'noop' is unknown → executeTool returns an error result; isError must be surfaced.
  expect("tool_result emitted with isError", tr && tr.isError === true);
  expect("final answer text", r.finalText === "done");
  // The assembled tool_use input survived into the message history.
  expect(
    "tool_use input round-tripped in messages",
    r.messages.some((m) => m.content.some((c) => c.type === "tool_use" && c.input?.a === 1)),
  );
}

// 3. No sink → buffered complete() path, no events, stream() never touched.
{
  const provider = {
    id: "fake",
    capabilities: caps,
    async complete() {
      return { message: { role: "assistant", content: [{ type: "text", text: "buffered" }] }, stopReason: "end_turn" };
    },
    stream() {
      throw new Error("stream() must not be called without a sink");
    },
  };
  const r = await makeKernel(provider).run("go"); // no onEvent
  expect("buffered fallback returns final text", r.finalText === "buffered");
}

// 4. End-to-end: kernel events drive the real CliChannel.streamSink, rendering to stdout.
{
  async function* turn() {
    yield { type: "thinking_delta", text: "pondering" };
    yield { type: "text_delta", text: "the " };
    yield { type: "text_delta", text: "answer" };
    yield {
      type: "result",
      result: { message: { role: "assistant", content: [{ type: "text", text: "the answer" }] }, stopReason: "end_turn" },
    };
  }
  const cli = new CliChannel({ defaultAgent: "x" });
  const sink = cli.streamSink();
  // Capture stdout for the duration of the streamed run, then restore before asserting.
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (s) => {
    chunks.push(String(s));
    return true;
  };
  try {
    await makeKernel(streamingProvider([turn])).run("go", undefined, sink);
  } finally {
    process.stdout.write = orig;
  }
  const out = chunks.join("");
  expect("cli streamSink rendered the streamed text", out.includes("the answer"));
  expect("cli streamSink rendered reasoning marker", out.includes("💭") && out.includes("pondering"));
  expect("cli streamSink finalized the prompt", out.includes("> "));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
