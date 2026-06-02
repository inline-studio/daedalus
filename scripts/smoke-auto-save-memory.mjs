// Smoke for the deterministic memory auto-save curator. Covers the pure, testable pieces:
//   - parseExtractedFacts: tolerant JSON parsing of the extractor's reply (fences, prose,
//     malformed entries, dedup, empty → []).
//   - renderTurnTranscript: compact transcript with tool I/O truncated, images skipped,
//     and tail-kept when over budget.
//   - findAddMemoryTool: locates Graphiti's add_memory (and fuzzy fallbacks) on a server.
// The live extraction + MCP write is exercised end-to-end by the docker memory smoke, not here.

import {
  parseExtractedFacts,
  renderTurnTranscript,
  findAddMemoryTool,
} from "../dist/memory/auto-save.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// --- parseExtractedFacts ---
{
  const facts = parseExtractedFacts('[{"name":"Fav colour","body":"The user\'s favourite colour is blue."}]');
  expect("plain array parses", facts.length === 1 && facts[0].body.includes("blue"));
}
{
  const fenced = "```json\n[{\"name\":\"Client\",\"body\":\"Spot Design is a client.\"}]\n```";
  expect("strips code fence", parseExtractedFacts(fenced).length === 1);
}
{
  const prose = 'Sure! Here are the facts:\n[{"name":"X","body":"The user lives in Derbyshire."}]\nLet me know!';
  const f = parseExtractedFacts(prose);
  expect("isolates array from surrounding prose", f.length === 1 && f[0].body.includes("Derbyshire"));
}
{
  expect("empty array → []", parseExtractedFacts("[]").length === 0);
  expect("garbage → []", parseExtractedFacts("no json here").length === 0);
  expect("not-an-array → []", parseExtractedFacts('{"body":"x"}').length === 0);
}
{
  const f = parseExtractedFacts('[{"name":"a","body":"  "},{"body":"Has body, no name."},{"name":"b"}]');
  expect("drops empty-body, keeps name-less-with-body, drops body-less", f.length === 1 && f[0].name.length > 0);
}
{
  const dup = parseExtractedFacts('[{"name":"a","body":"Same fact."},{"name":"b","body":"same fact."}]');
  expect("dedups by body (case-insensitive)", dup.length === 1);
}

// --- renderTurnTranscript ---
{
  const t = renderTurnTranscript([
    { role: "user", content: [{ type: "text", text: "Remember I prefer blue." }] },
    {
      role: "assistant",
      content: [
        { type: "text", text: "Noted." },
        { type: "tool_use", id: "1", name: "memory__add_memory", input: { episode_body: "x" } },
      ],
    },
    { role: "user", content: [{ type: "tool_result", toolUseId: "1", content: "queued" }] },
  ]);
  expect("includes user + assistant text", t.includes("USER:") && t.includes("prefer blue") && t.includes("Noted"));
  expect("renders tool_use compactly", t.includes("[called memory__add_memory"));
  expect("renders tool_result compactly", t.includes("[result: queued]"));
}
{
  const t = renderTurnTranscript([
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "tool", content: [{ type: "text", text: "ignored" }] },
  ]);
  expect("non-user/assistant roles are skipped", t.includes("USER: hi") && !t.includes("ignored"));
}
{
  const long = "x".repeat(20_000);
  const t = renderTurnTranscript([{ role: "user", content: [{ type: "text", text: long }] }], { maxChars: 5000 });
  expect("over-budget transcript is tail-truncated", t.length <= 5002 && t.startsWith("…"));
}

// --- findAddMemoryTool ---
const srv = (toolNames) => ({ name: "memory", tools: toolNames.map((n) => ({ name: n })) });
{
  const s = srv(["memory__search_memory_nodes", "memory__add_memory", "memory__get_episodes"]);
  expect("finds exact add_memory", findAddMemoryTool(s) === "memory__add_memory");
}
{
  const s = srv(["memory__search_facts", "memory__add_episode"]);
  expect("fuzzy-matches add_episode", findAddMemoryTool(s) === "memory__add_episode");
}
{
  const s = srv(["memory__search_memory_nodes", "memory__get_episodes"]);
  expect("no add tool → null", findAddMemoryTool(s) === null);
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
