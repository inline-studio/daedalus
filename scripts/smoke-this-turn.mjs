// Combined smoke for:
//   B. identity command + composer injection
//   C. ask_user / subagent state-machine wiring (no live LLM — exercise the kernel directly)

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// ────────────────────────────────────────────────────────────────────────────────
// B. identity show / set
// ────────────────────────────────────────────────────────────────────────────────
console.log("\n── B: identity ──");
const tmpDir = path.join(os.tmpdir(), `dae-this-turn-${Date.now()}`);
await fs.mkdir(tmpDir, { recursive: true });
const cfgPath = path.join(tmpDir, "daedalus.config.yaml");
await fs.writeFile(
  cfgPath,
  `
brain:
  path: ${path.resolve("examples/brain").replaceAll("\\", "/")}

identity:
  name: Artemis
`.trim() + "\n",
  "utf8",
);

{
  const r = spawnSync("node", ["dist/index.js", "-c", cfgPath, "identity"], { encoding: "utf8" });
  expect("identity (show) reports current name", r.stdout.includes("name:     Artemis"));
}
{
  const r = spawnSync("node", ["dist/index.js", "-c", cfgPath, "identity", "Claudia", "--nickname", "Claud"], {
    encoding: "utf8",
  });
  expect("identity set exit 0", r.status === 0);
  const cfg = await fs.readFile(cfgPath, "utf8");
  expect("yaml: name updated", /name:\s*Claudia/.test(cfg));
  expect("yaml: nickname set", /nickname:\s*Claud/.test(cfg));
}

// composer injects identity section when identity is provided
const composerMod = await import("../dist/brain/composer.js");
const agentMod = await import("../dist/brain/agents.js");
const { manifest, body } = await agentMod.loadAgent(path.resolve("examples/brain"), "orchestrator");

const orchPrompt = await composerMod.composeSystemPrompt({
  brainPath: path.resolve("examples/brain"),
  agent: manifest,
  agentBody: body,
  skills: [],
  identity: { name: "Claudia", nickname: "Claud" },
  isSubagent: false,
});
expect("orchestrator system prompt contains '# Identity'", /^# Identity/m.test(orchPrompt));
expect("orchestrator system prompt mentions Claudia", /You are \*\*Claudia\*\*/.test(orchPrompt));
expect("orchestrator gets PENDING_QUESTION guidance", /PENDING_QUESTION/.test(orchPrompt));

const subPrompt = await composerMod.composeSystemPrompt({
  brainPath: path.resolve("examples/brain"),
  agent: manifest,
  agentBody: body,
  skills: [],
  identity: { name: "Claudia" },
  isSubagent: true,
});
expect("subagent prompt frames Claudia as user-facing", /called by \*\*Claudia\*\*/.test(subPrompt));
expect("subagent prompt references ask_user tool", /ask_user/.test(subPrompt));

// ────────────────────────────────────────────────────────────────────────────────
// C. ask_user signal + subagent state machine (no live LLM)
// ────────────────────────────────────────────────────────────────────────────────
console.log("\n── C: ask_user / subagent state ──");
const askMod = await import("../dist/tools/ask-user.js");

// 1. ask_user tool throws AskUserSignal
let threw = null;
try {
  await askMod.askUserTool.invoke({ question: "What's the deadline?" }, /** @type {any} */ ({}));
} catch (e) {
  threw = e;
}
expect("ask_user throws AskUserSignal", threw instanceof askMod.AskUserSignal);
expect("AskUserSignal carries the question", threw?.question === "What's the deadline?");

// 2. Kernel catches the signal and returns pendingQuestion (no fake tool_result emitted)
const { Kernel } = await import("../dist/kernel/agent.js");

// Fake provider that emits a single tool_use(ask_user) on first call.
const fakeProvider = {
  id: "fake",
  capabilities: { tools: true, streaming: false, vision: false, systemPromptAsField: true },
  async complete() {
    return {
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "ask_user",
            input: { question: "What's the deadline?" },
          },
        ],
      },
      stopReason: "tool_use",
    };
  },
};

const kernel = new Kernel({
  provider: fakeProvider,
  model: "x",
  system: "test",
  builtinTools: [askMod.askUserTool],
  mcpServers: new Map(),
  toolContext: {
    runtime: { id: "host", exec: async () => ({ stdout: "", stderr: "", exitCode: 0, timedOut: false }) },
    brainPath: "/tmp",
    brainWritable: false,
    workspacePath: "/tmp",
    agentName: "test",
  },
  maxTurns: 5,
  maxTokens: 1024,
});

const result = await kernel.runWithMessages([
  { role: "user", content: [{ type: "text", text: "Help me ship the thing" }] },
]);
expect("kernel halts on ask_user (stopReason)", result.stopReason === "ask_user");
expect("kernel surfaces pendingQuestion", result.pendingQuestion?.question === "What's the deadline?");
expect("kernel records the right toolUseId", result.pendingQuestion?.toolUseId === "tu_1");
// Critical: messages should NOT have a fabricated tool_result for tu_1 — the resume path
// fills that in once the user actually answers.
const lastMsg = result.messages[result.messages.length - 1];
expect("last persisted message is the assistant tool_use (not a tool_result)", lastMsg.role === "assistant");
const hasToolResultForTU1 = result.messages.some(
  (m) =>
    m.role === "user" &&
    m.content.some((c) => c.type === "tool_result" && c.toolUseId === "tu_1"),
);
expect("no synthetic tool_result for the open ask_user", !hasToolResultForTU1);

await fs.rm(tmpDir, { recursive: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
