// Smoke for the proactive history token-budget: the loaded tail is trimmed (oldest-first)
// to fit a token budget BEFORE the turn runs, keeps the most recent message, never opens
// mid-exchange, and leaves small histories untouched.

import { estimateTokens, budgetTail } from "../dist/kernel/context-budget.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const userText = (n) => ({ role: "user", content: [{ type: "text", text: "x".repeat(n) }] });
const asstText = (n) => ({ role: "assistant", content: [{ type: "text", text: "y".repeat(n) }] });
const sum = (msgs) => msgs.reduce((s, m) => s + estimateTokens(m.content), 0);
const startsBad = (m) =>
  m.role === "assistant" || (m.role === "user" && m.content.some((c) => c.type === "tool_result"));

// 1. estimateTokens ≈ chars / 4.
expect("estimateTokens ≈ chars/4", estimateTokens([{ type: "text", text: "a".repeat(400) }]) === 100);

// 2. Budget keeps a recent suffix and drops the oldest.
{
  // 10 alternating messages, ~1000 tokens each (4000 chars).
  const msgs = [];
  for (let i = 0; i < 10; i++) msgs.push(i % 2 === 0 ? userText(4000) : asstText(4000));
  const out = budgetTail(msgs, 3500);
  expect("trims when over budget", out.length < msgs.length && out.length >= 1, `len=${out.length}`);
  expect("keeps the most recent message", out[out.length - 1] === msgs[msgs.length - 1]);
  expect("fits within budget", sum(out) <= 3500, `tokens=${sum(out)}`);
  expect("does not open mid-exchange", !startsBad(out[0]));
}

// 3. Always keeps the last message even if it alone exceeds the budget.
{
  const msgs = [userText(40), userText(400_000)];
  const out = budgetTail(msgs, 1000);
  expect("keeps last even when oversized", out.length >= 1 && out[out.length - 1] === msgs[1]);
}

// 4. Small history under budget is returned unchanged.
{
  const msgs = [userText(40), asstText(40), userText(40)];
  const out = budgetTail(msgs, 100_000);
  expect("under-budget history unchanged", out.length === msgs.length);
}

// 5. Never strands a dangling tool_result at the head.
{
  const msgs = [
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "web_fetch", input: {} }] },
    { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "z".repeat(60_000) }] },
    { role: "user", content: [{ type: "text", text: "thanks" }] },
  ];
  const out = budgetTail(msgs, 200); // only the tiny last message fits
  expect("head is not a bare tool_result", !startsBad(out[0]), `role=${out[0].role}`);
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
