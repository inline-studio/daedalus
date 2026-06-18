// Smoke for streaming Phase 0 (provider stream() foundation):
//  - foldStream() drains a ProviderStreamEvent iterable and returns the terminal result;
//  - foldStream() throws if a stream ends without a result event;
//  - createThinkStreamSplitter() separates inline <think>…</think> reasoning from visible text,
//    including tags split across chunk boundaries, multiple blocks, and an unclosed trailer;
//  - both providers expose a stream() method and advertise capabilities.streaming.

import { foldStream } from "../dist/providers/base.js";
import { createThinkStreamSplitter } from "../dist/providers/stream-util.js";
import { AnthropicProvider } from "../dist/providers/anthropic.js";
import { OpenAICompatibleProvider } from "../dist/providers/openai.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

async function* gen(events) {
  for (const e of events) yield e;
}

// Feed a string to the splitter one chunk at a time, collecting all text/thinking emitted.
function runSplitter(chunks) {
  const s = createThinkStreamSplitter();
  let text = "";
  let think = "";
  for (const c of chunks) {
    const r = s.push(c);
    text += r.textDelta;
    think += r.thinkingDelta;
  }
  const tail = s.end();
  text += tail.textDelta;
  think += tail.thinkingDelta;
  return { text, think };
}

// 1. foldStream returns the terminal result.
{
  const result = { message: { role: "assistant", content: [{ type: "text", text: "hi" }] }, stopReason: "end_turn" };
  const got = await foldStream(
    gen([{ type: "text_delta", text: "h" }, { type: "text_delta", text: "i" }, { type: "result", result }]),
  );
  expect("foldStream returns the terminal result", got === result);
}

// 2. foldStream throws when no result event is emitted.
{
  let threw = false;
  try {
    await foldStream(gen([{ type: "text_delta", text: "x" }]));
  } catch {
    threw = true;
  }
  expect("foldStream throws without a result event", threw);
}

// 3. Splitter: a clean block in one chunk.
{
  const { text, think } = runSplitter(["<think>reasoning</think>answer"]);
  expect("splitter: single chunk block", text === "answer" && think === "reasoning", `text=${text} think=${think}`);
}

// 4. Splitter: tag split across chunk boundaries (the key streaming case).
{
  const { text, think } = runSplitter(["abc<thi", "nk>secret th", "oughts</thi", "nk>visible"]);
  expect(
    "splitter: tags split across chunks",
    text === "abcvisible" && think === "secret thoughts",
    `text=${text} think=${think}`,
  );
}

// 5. Splitter: multiple blocks.
{
  const { text, think } = runSplitter(["<think>a</think>X<think>b</think>Y"]);
  expect("splitter: multiple blocks", text === "XY" && think === "ab", `text=${text} think=${think}`);
}

// 6. Splitter: unclosed trailing <think> (truncated reasoning) flushes as thinking.
{
  const { text, think } = runSplitter(["visible<think>still going"]);
  expect("splitter: unclosed trailer → thinking", text === "visible" && think === "still going");
}

// 7. Splitter: a lone '<' that isn't a tag stays visible.
{
  const { text, think } = runSplitter(["1 < 2 and 3 > 2"]);
  expect("splitter: bare '<' is not a tag", text === "1 < 2 and 3 > 2" && think === "");
}

// 8. Both providers expose stream() and advertise streaming capability.
{
  const a = new AnthropicProvider({ apiKey: "x" });
  const o = new OpenAICompatibleProvider({ apiKey: "x" });
  expect("anthropic: stream() present + capability", typeof a.stream === "function" && a.capabilities.streaming === true);
  expect("openai: stream() present + capability", typeof o.stream === "function" && o.capabilities.streaming === true);
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
