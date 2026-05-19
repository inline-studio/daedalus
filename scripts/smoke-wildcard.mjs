// Smoke: `['*']` wildcard expansion across the four manifest fields that
// support it — tools, skills, mcpServers, subagents. Empty list / omitted
// field must always mean "none" (the security default).
//
// Exercises:
//   - selectBuiltins(['*'], …) returns every built-in tool
//   - selectBuiltins([], …) returns nothing (regression guard)
//   - buildSpawnSubagentTool with subagents=['*'] resolves to every agent in
//     the brain minus self
//   - buildSpawnSubagentTool with subagents=[] returns null (no tool exposed)
//
// Skills + MCP wildcards run via agent-turn.ts which needs a real provider /
// session DB to exercise end-to-end. We check those by inspecting the schema
// expansion functions directly + relying on the manifest-level assertion that
// the field is plumbed (subagents test covers the pattern; skills/mcp use the
// same Array.includes('*') idiom).

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectBuiltins, builtinNames } from "../dist/tools/registry.js";
import { buildSpawnSubagentTool } from "../dist/kernel/orchestrator.js";
import { ScheduleStore } from "../dist/sessions/schedule-store.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

function fakeConfig(brainPath) {
  return {
    brain: { path: brainPath, writable: false },
    runtime: { default: "host", dispatcher: "process", shared: { enabled: false, hostPath: "", containerPath: "" } },
    sessions: { dbPath: "/tmp/test.sqlite", attachmentsPath: "/tmp/atts", historyLimit: 80 },
    identity: { name: "Test" },
    web: { search: { provider: "none" }, fetch: { maxBytes: 1024, timeoutMs: 5000 } },
  };
}

// 1a. selectBuiltins(['*']) WITH a scheduleStore returns every built-in.
{
  const dir = mkdtempSync(join(tmpdir(), "dae-wildcard-store-"));
  const store = new ScheduleStore(join(dir, "test.sqlite"));
  const all = selectBuiltins(["*"], fakeConfig("/nowhere"), { scheduleStore: store });
  const names = all.map((t) => t.definition.name).sort();
  const expected = [...builtinNames()].sort();
  expect(
    "selectBuiltins(['*']) WITH scheduleStore returns every built-in",
    JSON.stringify(names) === JSON.stringify(expected),
    `got ${names.length} tools (${names.join(",")}), expected ${expected.length}`,
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

// 1b. selectBuiltins(['*']) WITHOUT a scheduleStore returns everything EXCEPT
// schedule-store-dependent tools. Wildcard semantics: "give me what's
// available", not "throw because one is missing".
{
  const all = selectBuiltins(["*"], fakeConfig("/nowhere"));
  const names = all.map((t) => t.definition.name).sort();
  const expected = builtinNames()
    .filter((n) => !["schedule_message", "cancel_scheduled_message", "list_scheduled_messages"].includes(n))
    .sort();
  expect(
    "selectBuiltins(['*']) WITHOUT scheduleStore skips schedule tools",
    JSON.stringify(names) === JSON.stringify(expected),
    `got ${names.join(",")}; expected ${expected.join(",")}`,
  );
}

// 1c. Explicit named schedule tool WITHOUT a store still throws (not a
// wildcard — caller asked for this specifically, so silently skipping would
// hide a real bug).
{
  let threw = false;
  try {
    selectBuiltins(["schedule_message"], fakeConfig("/nowhere"));
  } catch {
    threw = true;
  }
  expect("explicit schedule_message WITHOUT scheduleStore throws", threw);
}

// 2. selectBuiltins([]) returns NOTHING (regression guard for the security
// hardening that turned the old "empty = all" footgun off).
{
  const empty = selectBuiltins([], fakeConfig("/nowhere"));
  expect("selectBuiltins([]) returns no tools (security default)", empty.length === 0);
}

// 3. selectBuiltins(['bash', 'read']) returns exactly those two (subset still works).
{
  const subset = selectBuiltins(["bash", "read"], fakeConfig("/nowhere"));
  const names = subset.map((t) => t.definition.name).sort();
  expect(
    "selectBuiltins(['bash','read']) returns exactly those two",
    JSON.stringify(names) === JSON.stringify(["bash", "read"]),
    `got ${names.join(",")}`,
  );
}

// 4. buildSpawnSubagentTool with subagents=['*'] discovers every agent in the
// brain (minus self).
{
  const brain = mkdtempSync(join(tmpdir(), "dae-wildcard-brain-"));
  mkdirSync(join(brain, "agents"));
  for (const name of ["artemis", "cypher", "sentinel", "vector"]) {
    writeFileSync(
      join(brain, "agents", `${name}.md`),
      `---\nprovider: anthropic\nmodel: claude-sonnet-4-6\n---\n# ${name}\n`,
    );
  }
  const tool = await buildSpawnSubagentTool({
    config: fakeConfig(brain),
    parent: {
      name: "artemis",
      description: "",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      maxTurns: 50,
      maxTokens: 4096,
      mcpServers: [],
      skills: [],
      souls: [],
      personas: [],
      subagents: ["*"], // ← the wildcard under test
      tools: [],
      commands: [],
      timeAware: false,
    },
    sessions: /* not invoked */ null,
    userId: "u",
    dispatcher: /* not invoked */ null,
  });
  expect("buildSpawnSubagentTool returns a tool when subagents=['*']", tool !== null);
  if (tool) {
    const enumed = tool.definition.inputSchema.properties.agent.enum;
    const sorted = [...enumed].sort();
    expect(
      "wildcard expanded to the 3 non-self agents (artemis excluded)",
      JSON.stringify(sorted) === JSON.stringify(["cypher", "sentinel", "vector"]),
      `got: ${sorted.join(",")}`,
    );
  }
  rmSync(brain, { recursive: true, force: true });
}

// 5. buildSpawnSubagentTool with subagents=[] still returns null (no
// spawn_subagent tool exposed — subagent default).
{
  const brain = mkdtempSync(join(tmpdir(), "dae-wildcard-brain-"));
  mkdirSync(join(brain, "agents"));
  writeFileSync(join(brain, "agents", "leaf.md"), `---\nprovider: anthropic\nmodel: claude-sonnet-4-6\n---\n`);
  const tool = await buildSpawnSubagentTool({
    config: fakeConfig(brain),
    parent: {
      name: "leaf",
      description: "",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      maxTurns: 50,
      maxTokens: 4096,
      mcpServers: [],
      skills: [],
      souls: [],
      personas: [],
      subagents: [],
      tools: [],
      commands: [],
      timeAware: false,
    },
    sessions: null,
    userId: "u",
    dispatcher: null,
  });
  expect("buildSpawnSubagentTool returns null when subagents=[]", tool === null);
  rmSync(brain, { recursive: true, force: true });
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
