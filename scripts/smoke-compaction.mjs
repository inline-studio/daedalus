// Smoke for reactive auto-compaction: on a real "context exceeded" error the kernel
// summarises the older history into a synopsis, keeps recent turns, retries, and surfaces
// a user-facing notice. Summariser failure falls back to dropping (never blocks a turn).
// No hardcoded context size anywhere — it triggers on the provider's actual overflow.

import { Kernel } from "../dist/kernel/agent.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const okMsg = { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, stopReason: "end_turn" };
const overflow = () =>
  new Error("400 litellm.BadRequestError - request (81302 tokens) exceeds the available context size (65536 tokens)");
const isSummaryReq = (req) => req.system.includes("compress conversation history");

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

function history(n) {
  const msgs = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}` }] });
  }
  return msgs;
}

// 1. Overflow → summarise older → retry succeeds; exactly one summary call; notice surfaced.
{
  let summarizeCalls = 0;
  let mainCalls = 0;
  const provider = {
    id: "fake",
    capabilities: {},
    async complete(req) {
      if (isSummaryReq(req)) {
        summarizeCalls++;
        return {
          message: { role: "assistant", content: [{ type: "text", text: "SUMMARY: user asked about widgets; chose X." }] },
          stopReason: "end_turn",
        };
      }
      mainCalls++;
      if (req.messages.length > 6) throw overflow(); // ~6 fit; 12 → compact to 6 → fits
      return okMsg;
    },
  };
  const r = await makeKernel(provider).runWithMessages(history(12));
  expect("completes after compaction", r.finalText === "ok");
  expect("summariser invoked exactly once", summarizeCalls === 1, `calls=${summarizeCalls}`);
  expect("compaction resolved the overflow without dropping", mainCalls === 2, `mainCalls=${mainCalls}`);
  expect(
    "surfaces a compaction notice",
    Array.isArray(r.notices) && r.notices.some((n) => /summari|compact/i.test(n)),
    JSON.stringify(r.notices),
  );
}

// 2. No overflow → no summary call, no notices.
{
  const provider = {
    id: "fake",
    capabilities: {},
    async complete(req) {
      if (isSummaryReq(req)) throw new Error("should not summarise");
      return okMsg;
    },
  };
  const r = await makeKernel(provider).runWithMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  expect("no notices when nothing overflows", !r.notices || r.notices.length === 0);
}

// 3. Summariser failure → falls back to dropping oldest; still completes; no false notice.
{
  let mainCalls = 0;
  const provider = {
    id: "fake",
    capabilities: {},
    async complete(req) {
      if (isSummaryReq(req)) throw new Error("summary upstream 500");
      mainCalls++;
      if (req.messages.length > 3) throw overflow();
      return okMsg;
    },
  };
  const r = await makeKernel(provider).runWithMessages(history(10));
  expect("falls back to drop when summariser fails", r.finalText === "ok", `mainCalls=${mainCalls}`);
  expect(
    "no compaction notice when summary failed",
    !r.notices || !r.notices.some((n) => /summari|compact/i.test(n)),
    JSON.stringify(r.notices ?? []),
  );
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
