// Smoke for the stream-inactivity (idle) timeout in OpenAICompatibleProvider (sessions.
// streamIdleTimeoutMs). The guard must:
//   - abort a stream that goes SILENT for longer than the idle window, surfacing a TIMEOUT-
//     shaped error (so the kernel classifies it as a timeout, not a generic failure);
//   - NOT cut off a slow-but-progressing stream — one that keeps emitting tokens slower than
//     nothing but never actually stalls — proving slowness alone never trips the timer;
//   - be disabled entirely when the window is 0 (SDK wall-clock only).

import http from "node:http";
import { foldStream } from "../dist/providers/base.js";
import { OpenAICompatibleProvider } from "../dist/providers/openai.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;
const tokenChunk = (text) => sse({ choices: [{ index: 0, delta: { content: text } }] });

// Mock OpenAI-compatible SSE endpoint. `mode` (a module-level switch) selects the behaviour.
let mode = "progress";
const server = http.createServer(async (req, res) => {
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  if (mode === "stall") {
    // Emit one token, then go silent forever (never send more, never end) → the idle timer
    // is the only thing that can end this request.
    res.write(tokenChunk("hi"));
    return; // deliberately hang
  }
  // "progress": a token every 60ms for 8 chunks, then a clean finish. Slow, but never silent.
  for (let i = 0; i < 8; i++) {
    res.write(tokenChunk(`t${i} `));
    await sleep(60);
  }
  res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise((r) => server.listen(0, "127.0.0.1", r));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const req = {
  system: "test",
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  model: "test",
  maxTokens: 64,
};

// 1. A stalled stream aborts on the idle window (150ms) with a timeout-shaped error, promptly.
{
  mode = "stall";
  const p = new OpenAICompatibleProvider({ flavor: "openai", baseUrl, apiKey: "x", idleTimeoutMs: 150 });
  const t0 = Date.now();
  let msg = "";
  try {
    await foldStream(p.stream(req));
  } catch (err) {
    msg = err?.message ?? String(err);
  }
  const dt = Date.now() - t0;
  expect("stalled stream throws", msg !== "", msg);
  expect("error reads as a timeout (kernel-classifiable)", /timed out|stalled|no output/i.test(msg), msg);
  expect("aborts near the idle window, doesn't hang", dt >= 100 && dt < 3000, `${dt}ms`);
}

// 2. A slow-but-progressing stream (60ms gaps) is NOT cut off by a 200ms idle window.
{
  mode = "progress";
  const p = new OpenAICompatibleProvider({ flavor: "openai", baseUrl, apiKey: "x", idleTimeoutMs: 200 });
  let result, msg = "";
  try {
    result = await foldStream(p.stream(req));
  } catch (err) {
    msg = err?.message ?? String(err);
  }
  expect("progressing stream completes (no premature timeout)", msg === "", msg);
  const text = result?.message?.content?.find((c) => c.type === "text")?.text ?? "";
  expect("assembled the full streamed text", text.includes("t0") && text.includes("t7"), JSON.stringify(text));
}

// 3. idleTimeoutMs = 0 disables the guard — streaming still works end to end.
{
  mode = "progress";
  const p = new OpenAICompatibleProvider({ flavor: "openai", baseUrl, apiKey: "x", idleTimeoutMs: 0 });
  let ok = false;
  try {
    ok = !!(await foldStream(p.stream(req)));
  } catch {
    ok = false;
  }
  expect("idleTimeoutMs=0 leaves streaming working", ok);
}

server.close();
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
