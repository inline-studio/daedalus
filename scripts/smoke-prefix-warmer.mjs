// Smoke for the prompt-prefix warmer (src/kernel/prefix-warmer.ts). The warmer's whole
// value is BYTE-IDENTITY with a real top-level turn's prompt prefix, so the core assertion
// here is: the CompletionRequest the warmer sends carries exactly the {system, tools}
// that assembleAgentCore + assembleTurnTools + mergeToolDefs produce for the same agent —
// plus maxTokens=1, a single user message, and graceful failure handling.

import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtemisConfigSchema } from "../dist/config/schema.js";
import { warmAgentPrefix, resolveWarmAgents } from "../dist/kernel/prefix-warmer.js";
import { assembleAgentCore, assembleTurnTools } from "../dist/kernel/agent-turn.js";
import { mergeToolDefs } from "../dist/kernel/agent.js";
import { SessionStore } from "../dist/sessions/store.js";
import { ScheduleStore } from "../dist/sessions/schedule-store.js";
import { AttachmentStore } from "../dist/attachments/store.js";
import { AttachmentIndexStore } from "../dist/attachments/index-store.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// --- scaffold: temp brain with one agent, no skills, no MCP ---
const dir = mkdtempSync(join(tmpdir(), "dae-smoke-warmer-"));
const brain = join(dir, "brain");
mkdirSync(join(brain, "agents"), { recursive: true });
writeFileSync(
  join(brain, "agents", "testagent.md"),
  `---\nname: testagent\ndescription: warm target\nprovider: openai\nmodel: test-model\n---\nYou are a test agent.\n`,
);

const config = ArtemisConfigSchema.parse({
  brain: { path: brain },
  providers: { openai: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1/v1" } },
  runtime: { dispatcher: "process" },
  sessions: {
    dbPath: join(dir, "sessions.sqlite"),
    attachmentsPath: join(dir, "attachments"),
    historyLimit: 40,
  },
  channels: { web: { enabled: true, defaultAgent: "testagent" } },
  warming: { enabled: true },
});

// --- 1. the warm request is byte-identical to a real turn's prefix ---
{
  let captured;
  const provider = {
    id: "fake",
    capabilities: { tools: true, streaming: false, vision: false, systemPromptAsField: false },
    async complete(req) {
      captured = req;
      return {
        message: { role: "assistant", content: [{ type: "text", text: "." }] },
        stopReason: "max_tokens",
      };
    },
  };
  const result = await warmAgentPrefix(config, "testagent", { provider });
  expect("warm reports ok", result.ok === true, result.error ?? "");
  expect("one request sent", captured !== undefined);
  expect("maxTokens is 1", captured?.maxTokens === 1);
  expect("model from the agent manifest", captured?.model === "test-model");
  expect(
    "single short user message",
    captured?.messages.length === 1 &&
      captured.messages[0].role === "user" &&
      captured.messages[0].content.length === 1,
  );

  // Reference assembly — the exact code path a real turn uses.
  const sessions = new SessionStore(config.sessions.dbPath);
  const scheduleStore = new ScheduleStore(config.sessions.dbPath);
  const attachments = new AttachmentStore(config.sessions.attachmentsPath);
  await attachments.ensureDir();
  // Same store gating as runAgentTurn/warmAgentPrefix — which stores exist decides
  // which tools get built.
  const attachmentIndex = config.sessions.attachmentIndex.enabled
    ? new AttachmentIndexStore(config.sessions.dbPath)
    : undefined;
  try {
    const core = await assembleAgentCore(config, "testagent", false);
    const tools = await assembleTurnTools({
      config,
      agent: core.agent,
      skills: core.skills,
      isSubagent: false,
      userId: "prefix-warmer",
      sessions,
      scheduleStore,
      attachments,
      ...(attachmentIndex ? { attachmentIndex } : {}),
    });
    expect("system prompt byte-identical to a real turn's", captured?.system === core.system);
    const wantDefs = JSON.stringify(mergeToolDefs(tools.builtinTools, tools.mcpServers));
    expect(
      "tool definitions byte-identical (content AND order)",
      JSON.stringify(captured?.tools) === wantDefs,
    );
    expect("tool list is non-trivial", (captured?.tools.length ?? 0) >= 2, `${captured?.tools.length} defs`);
    for (const s of tools.mcpServers.values()) await s.close().catch(() => undefined);
  } finally {
    sessions.close();
    scheduleStore.close();
    attachmentIndex?.close();
  }
}

// --- 2. provider failure is contained (warm never throws) ---
{
  const provider = {
    id: "fake",
    capabilities: { tools: true, streaming: false, vision: false, systemPromptAsField: false },
    async complete() {
      throw new Error("backend down");
    },
  };
  const result = await warmAgentPrefix(config, "testagent", { provider });
  expect("failed warm reports ok:false", result.ok === false);
  expect("failed warm carries the error", result.error === "backend down", result.error);
}

// --- 3. resolveWarmAgents ---
{
  expect(
    "empty warming.agents falls back to enabled channels' defaultAgent",
    JSON.stringify(resolveWarmAgents(config)) === JSON.stringify(["testagent"]),
  );
  const explicit = ArtemisConfigSchema.parse({
    brain: { path: brain },
    warming: { enabled: true, agents: ["a", "a", "b"] },
  });
  expect(
    "explicit warming.agents wins and dedups",
    JSON.stringify(resolveWarmAgents(explicit)) === JSON.stringify(["a", "b"]),
  );
  const none = ArtemisConfigSchema.parse({ brain: { path: brain } });
  expect("no channels, no agents → empty", resolveWarmAgents(none).length === 0);
}

console.log(`result: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
