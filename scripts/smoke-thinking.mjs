// Smoke for model-thinking surfacing (feature: extended thinking + reasoning capture):
//  - the Kernel forwards its `thinking` option into the completion request;
//  - per-turn usage is aggregated across every completion in a run;
//  - thinking content parts ride through the kernel into result.messages but are excluded
//    from finalText (which is the visible answer only);
//  - the Anthropic mapping preserves thinking blocks (with signature) when thinking is enabled,
//    strips them when disabled, drops signatureless/non-redacted blocks, and round-trips
//    redacted_thinking; fromAnthropicBlock captures both block kinds;
//  - the OpenAI <think>…</think> splitter extracts inline reasoning (incl. an unclosed block).

import { Kernel } from "../dist/kernel/agent.js";
import { toAnthropicMessage, fromAnthropicBlock } from "../dist/providers/anthropic.js";
import { splitThinkTags } from "../dist/providers/openai.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// A provider that replays a scripted list of CompletionResults by call index, recording each
// request it saw.
function scripted(results) {
  const calls = [];
  let i = 0;
  return {
    calls,
    provider: {
      id: "fake",
      capabilities: {},
      async complete(req) {
        calls.push(req);
        return results[Math.min(i++, results.length - 1)];
      },
    },
  };
}
const end = (content, usage) => ({ message: { role: "assistant", content }, stopReason: "end_turn", ...(usage ? { usage } : {}) });
const toolTurn = (usage) => ({
  message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }] },
  stopReason: "tool_use",
  ...(usage ? { usage } : {}),
});
const makeKernel = (provider, extra = {}) =>
  new Kernel({
    provider,
    model: "m",
    system: "s",
    builtinTools: [],
    mcpServers: new Map(),
    toolContext: {},
    maxTurns: 5,
    maxTokens: 4096,
    ...extra,
  });

// 1. Kernel forwards the thinking option into the request.
{
  const { calls, provider } = scripted([end([{ type: "text", text: "hi" }])]);
  await makeKernel(provider, { thinking: { budgetTokens: 2048 } }).run("go");
  expect(
    "thinking option forwarded into completion request",
    calls[0]?.thinking?.budgetTokens === 2048,
    JSON.stringify(calls[0]?.thinking),
  );
}

// 2. No thinking option ⇒ no thinking field on the request.
{
  const { calls, provider } = scripted([end([{ type: "text", text: "hi" }])]);
  await makeKernel(provider).run("go");
  expect("no thinking option ⇒ request omits thinking", calls[0]?.thinking === undefined);
}

// 3. Usage aggregates across every completion in the run (tool turn + final turn).
{
  const { provider } = scripted([
    toolTurn({ inputTokens: 100, outputTokens: 10, cacheReadTokens: 5 }),
    end([{ type: "text", text: "done" }], { inputTokens: 200, outputTokens: 20, cacheReadTokens: 7 }),
  ]);
  const r = await makeKernel(provider).run("go");
  expect(
    "usage summed across completions",
    r.usage?.inputTokens === 300 && r.usage?.outputTokens === 30 && r.usage?.cacheReadTokens === 12,
    JSON.stringify(r.usage),
  );
}

// 4. Thinking parts ride through to result.messages but are excluded from finalText.
{
  const { provider } = scripted([
    end([
      { type: "thinking", thinking: "let me reason", signature: "sig" },
      { type: "text", text: "the answer" },
    ]),
  ]);
  const r = await makeKernel(provider).run("go");
  const last = r.messages[r.messages.length - 1];
  const hasThinking = last.content.some((c) => c.type === "thinking" && c.thinking === "let me reason");
  expect("thinking part preserved in result.messages", hasThinking);
  expect("finalText excludes thinking text", r.finalText === "the answer", JSON.stringify(r.finalText));
}

// 5. Anthropic mapping: keep thinking (with signature) when enabled; strip when disabled.
{
  const msg = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "reason", signature: "abc" },
      { type: "tool_use", id: "x", name: "n", input: {} },
    ],
  };
  const kept = toAnthropicMessage(msg, true).content;
  const keptThinking = kept.find((b) => b.type === "thinking");
  expect(
    "thinking block kept verbatim (with signature) when enabled",
    keptThinking && keptThinking.thinking === "reason" && keptThinking.signature === "abc",
  );
  const stripped = toAnthropicMessage(msg, false).content;
  expect("thinking block stripped when disabled", !stripped.some((b) => b.type === "thinking"));
}

// 6. Signatureless, non-redacted thinking is dropped even when thinking is enabled
//    (the API can't verify it).
{
  const msg = { role: "assistant", content: [{ type: "thinking", thinking: "no sig" }, { type: "text", text: "a" }] };
  const out = toAnthropicMessage(msg, true).content;
  expect("signatureless thinking dropped", !out.some((b) => b.type === "thinking") && out.some((b) => b.type === "text"));
}

// 7. Redacted thinking round-trips as a redacted_thinking block.
{
  const msg = { role: "assistant", content: [{ type: "thinking", thinking: "OPAQUE", redacted: true }] };
  const out = toAnthropicMessage(msg, true).content;
  const red = out.find((b) => b.type === "redacted_thinking");
  expect("redacted thinking → redacted_thinking block", red && red.data === "OPAQUE");
}

// 8. fromAnthropicBlock captures both thinking kinds.
{
  const t = fromAnthropicBlock({ type: "thinking", thinking: "r", signature: "s" });
  const rd = fromAnthropicBlock({ type: "redacted_thinking", data: "D" });
  expect("fromAnthropicBlock: thinking", t.type === "thinking" && t.thinking === "r" && t.signature === "s");
  expect("fromAnthropicBlock: redacted_thinking", rd.type === "thinking" && rd.redacted === true && rd.thinking === "D");
}

// 9. OpenAI <think> splitter: extracts a closed block, multiple blocks, and an unclosed trailer.
{
  const a = splitThinkTags("<think>step one</think>visible answer");
  expect("split: closed block", a.thinking === "step one" && a.rest === "visible answer");
  const b = splitThinkTags("<think>a</think>mid<think>b</think>end");
  expect("split: multiple blocks", b.thinking === "ab" && b.rest === "midend");
  const c = splitThinkTags("before<think>still thinking, truncated");
  expect("split: unclosed trailing block", c.thinking === "still thinking, truncated" && c.rest === "before");
  const d = splitThinkTags("just text, no tags");
  expect("split: no tags ⇒ all visible", d.thinking === "" && d.rest === "just text, no tags");
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
