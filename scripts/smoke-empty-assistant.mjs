// Smoke for the empty-assistant-message regression: an assistant turn with no content
// and no tool_calls must (a) serialise to content:"" — never null — so the provider
// doesn't 400 ("assistant message must contain content or tool_calls"), and (b) be
// recognised as empty so it's never persisted in the first place.

import { toOpenAIMessages } from "../dist/providers/openai.js";
import { isEmptyAssistantMessage } from "../dist/kernel/agent-turn.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// --- provider serialisation (the crash fix) ---
{
  const empty = toOpenAIMessages({ role: "assistant", content: [] });
  expect(
    "empty assistant → content '' (not null), no tool_calls",
    empty.length === 1 && empty[0].content === "" && empty[0].tool_calls === undefined,
    JSON.stringify(empty[0]),
  );
}
{
  const toolOnly = toOpenAIMessages({
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
  });
  expect(
    "tool-only assistant → content null + tool_calls (valid)",
    toolOnly[0].content === null && Array.isArray(toolOnly[0].tool_calls) && toolOnly[0].tool_calls.length === 1,
    JSON.stringify(toolOnly[0]),
  );
}
{
  const withText = toOpenAIMessages({ role: "assistant", content: [{ type: "text", text: "hi" }] });
  expect("assistant text preserved", withText[0].content === "hi");
}

// --- empty-detection (the don't-persist fix) ---
expect("empty content → empty", isEmptyAssistantMessage({ role: "assistant", content: [] }) === true);
expect(
  "whitespace-only text → empty",
  isEmptyAssistantMessage({ role: "assistant", content: [{ type: "text", text: "  \n" }] }) === true,
);
expect(
  "has tool_use → not empty",
  isEmptyAssistantMessage({ role: "assistant", content: [{ type: "tool_use", id: "t", name: "x", input: {} }] }) === false,
);
expect("has text → not empty", isEmptyAssistantMessage({ role: "assistant", content: [{ type: "text", text: "hi" }] }) === false);
expect("user role is never flagged", isEmptyAssistantMessage({ role: "user", content: [] }) === false);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
