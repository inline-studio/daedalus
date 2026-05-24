// Smoke for context-window management in the kernel: on a "context length exceeded"
// provider error, drop oldest history and retry; when nothing's left to trim (the base
// prompt itself is too big), fail with a clear, actionable error.

import { Kernel } from "../dist/kernel/agent.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const ok = { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, stopReason: "end_turn" };

function makeKernel(provider) {
  return new Kernel({
    provider,
    model: "test",
    system: "s",
    builtinTools: [],
    mcpServers: new Map(),
    toolContext: {},
    maxTurns: 5,
    maxTokens: 100,
  });
}

const overflow = () => new Error("400 litellm.BadRequestError - request (81302 tokens) exceeds the available context size (65536 tokens)");

// 1. Trims oldest history until the request fits, then succeeds.
{
  const msgs = [];
  for (let i = 0; i < 12; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}` }] });
  }
  let seenLen = 0;
  const provider = {
    id: "fake",
    capabilities: {},
    async complete(req) {
      seenLen = req.messages.length;
      if (req.messages.length > 3) throw overflow(); // pretend only ~3 msgs fit
      return ok;
    },
  };
  const r = await makeKernel(provider).runWithMessages(msgs);
  expect("trims to fit and succeeds", r.finalText === "ok" && seenLen <= 3, `seenLen=${seenLen}`);
  // Full history is preserved in the returned messages (we trim only what's SENT).
  expect("does not mutate/lose the conversation", r.messages.length >= 12, `len=${r.messages.length}`);
}

// 2. Baseline too big (overflows even with one message) → clear, actionable error.
{
  const provider = {
    id: "fake",
    capabilities: {},
    async complete() {
      throw overflow();
    },
  };
  let threw = false;
  let msg = "";
  try {
    await makeKernel(provider).runWithMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  } catch (e) {
    threw = true;
    msg = String(e?.message ?? e);
  }
  expect(
    "baseline-too-big → actionable error",
    threw && /base prompt|trimmed further|context/i.test(msg),
    msg.slice(0, 120),
  );
}

// 3. A non-context error is NOT swallowed by the trim logic (still throws).
{
  const provider = {
    id: "fake",
    capabilities: {},
    async complete() {
      const e = new Error("Anthropic completion failed: 401 invalid x-api-key");
      e.status = 401;
      throw e;
    },
  };
  let threw = false;
  let msg = "";
  try {
    await makeKernel(provider).runWithMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  } catch (e) {
    threw = true;
    msg = String(e?.message ?? e);
  }
  expect("401 still surfaces (not treated as context overflow)", threw && /401/.test(msg), msg.slice(0, 80));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
