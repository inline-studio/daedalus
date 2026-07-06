// Unit smoke for compactCompletedLoops — the replay-time history compaction that strips
// bulky tool_result bodies from older completed turn-loops, keeping the N most recent at
// full fidelity. The persisted history is never touched; this is a pure transform.

import { compactCompletedLoops, capToolResults } from "../dist/kernel/history-compaction.js";

let pass = true;
const ok = (label, cond) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) pass = false;
};

// Build a synthetic conversation: 4 completed turn-loops + 1 in-progress.
// Each completed loop = user-text → assistant-tool_use → user-tool_result(big) → assistant-text.
const BIG = "x".repeat(40000); // ~40k chars — the kind of web_fetch dump we saw on casa
const loop = (n) => [
  { role: "user", content: [{ type: "text", text: `q${n}` }] },
  { role: "assistant", content: [{ type: "tool_use", id: `u${n}`, name: "web_fetch", input: { url: `https://x/${n}` } }] },
  { role: "user", content: [{ type: "tool_result", toolUseId: `u${n}`, content: BIG }] },
  { role: "assistant", content: [{ type: "text", text: `summary ${n}` }] },
];
const msgs = [...loop(1), ...loop(2), ...loop(3), ...loop(4)];
// In-progress 5th loop: user asked, agent made a tool_use, tool_result is back, but no final text yet.
const inProgress = [
  { role: "user", content: [{ type: "text", text: "q5" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "u5", name: "web_fetch", input: { url: "https://x/5" } }] },
  { role: "user", content: [{ type: "tool_result", toolUseId: "u5", content: BIG }] },
];
const all = [...msgs, ...inProgress];

// keepFullFidelityLoops: 2 → loops 4 and 5 (the in-progress one) stay full; loops 1–3 compact.
const out = compactCompletedLoops(all, { keepFullFidelityLoops: 2 });

ok("returns a new array of the same length", Array.isArray(out) && out.length === all.length);

// Loops 1-3 (indices 0..11) should have tool_result content REPLACED with a stub.
const stubbed = out.slice(0, 12).filter((m) => m.role === "user" && m.content.some((p) => p.type === "tool_result"));
ok("3 older tool_result messages were stubbed", stubbed.length === 3);
ok(
  "each stub is the short marker (not the original 40k)",
  stubbed.every((m) => m.content[0].content.startsWith("[tool_result:") && m.content[0].content.length < 200),
);
ok(
  "stubs preserve toolUseId so the conversation structure is intact",
  stubbed.every((m) => typeof m.content[0].toolUseId === "string" && m.content[0].toolUseId.length > 0),
);

// Loop 4 (kept) — its tool_result should still be the full BIG content.
const loop4Tr = out[14]; // index 14 = user-tool_result of loop 4 (3 loops * 4 msgs + 2 = 14)
ok(
  "loop 4 (kept full) tool_result still has full content",
  loop4Tr.role === "user" && loop4Tr.content[0].type === "tool_result" && loop4Tr.content[0].content.length === BIG.length,
);

// Loop 5 (in-progress, kept full): tool_result still full.
const loop5Tr = out[18]; // 4 loops * 4 + 2 = 18
ok(
  "in-progress loop tool_result still has full content (never compact incomplete loops)",
  loop5Tr.role === "user" && loop5Tr.content[0].type === "tool_result" && loop5Tr.content[0].content.length === BIG.length,
);

// tool_use parts should NEVER be touched (they're small + useful for traceability).
const toolUses = out.flatMap((m) => m.content.filter((p) => p.type === "tool_use"));
ok("all tool_use parts preserved unchanged", toolUses.length === 5 && toolUses.every((u) => typeof u.id === "string"));

// Edge cases.
ok("keepFullFidelityLoops: 0 returns input unchanged (disabled)", compactCompletedLoops(all, { keepFullFidelityLoops: 0 }) === all);
ok("empty messages returns empty", compactCompletedLoops([], { keepFullFidelityLoops: 2 }).length === 0);
ok(
  "≤ keep loops: nothing compacted",
  compactCompletedLoops(loop(1), { keepFullFidelityLoops: 2 }).find((m) =>
    m.role === "user" && m.content.some((p) => p.type === "tool_result" && p.content === BIG),
  ),
);

// Doesn't mutate the input (replay-time view, not destructive).
ok(
  "input messages are NOT mutated (persisted history stays full)",
  all[2].content[0].content === BIG && all[2].content[0].content.length === BIG.length,
);

// --- capToolResults: per-result size guardrail (even in kept loops) ---
{
  const kept = compactCompletedLoops(all, { keepFullFidelityLoops: 2 }); // last 2 loops still hold BIG
  const capped = capToolResults(kept, 8000);
  const bigResults = capped.flatMap((m) => m.content.filter((p) => p.type === "tool_result"));
  const stillHuge = bigResults.filter((p) => p.content.length > 8100); // 8000 + marker slack
  ok("capToolResults truncates over-cap results even in kept loops", stillHuge.length === 0, `${stillHuge.length} still huge`);
  const truncated = bigResults.find((p) => p.content.includes("truncated to fit context"));
  ok("truncated results keep a head + tail + marker", !!truncated && truncated.content.startsWith("x") && truncated.content.endsWith("x"));
  ok("under-cap results pass through untouched", capToolResults([{ role: "user", content: [{ type: "tool_result", toolUseId: "z", content: "small" }] }], 8000)[0].content[0].content === "small");
  ok("maxChars 0 disables the cap", capToolResults(kept, 0) === kept);
  ok("capToolResults does not mutate the input (BIG intact)", all[2].content[0].content.length === BIG.length);
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
