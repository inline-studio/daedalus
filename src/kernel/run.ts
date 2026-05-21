import path from "node:path";
import type { ArtemisConfig, AgentManifest } from "../config/schema.js";
import { Kernel } from "./agent.js";
import { buildProvider } from "../providers/index.js";
import { buildRuntime } from "../runtime/factory.js";
import { selectBuiltins } from "../tools/registry.js";
import { composeSystemPrompt } from "../brain/composer.js";
import { loadSkill, listSkills } from "../brain/skills.js";
import { connectMcpServer, type ConnectedServer } from "../mcp/client.js";
import { loadMcpConfig } from "../mcp/loader.js";
import { buildSpawnSubagentTool } from "./orchestrator.js";
import { buildSecretsBackend } from "../secrets/store/factory.js";
import { resolveProviderKey } from "../providers/resolve.js";
import { SessionStore } from "../sessions/store.js";
import { buildDispatcher } from "../dispatch/factory.js";
import { log } from "../log.js";

export interface RunAgentInput {
  config: ArtemisConfig;
  agent: AgentManifest;
  agentBody: string;
  prompt: string;
  // If a parent passes its connected MCP servers, reuse them; otherwise we connect ours.
  sharedMcp?: Map<string, ConnectedServer>;
  // True when this run is a subagent invocation. Drives the system-prompt identity hints.
  isSubagent?: boolean;
}

function identityFromConfig(config: ArtemisConfig): { name: string; nickname?: string } {
  const id = config.identity;
  return id.nickname ? { name: id.name, nickname: id.nickname } : { name: id.name };
}

export async function runAgent(input: RunAgentInput): Promise<{ finalText: string; turns: number }> {
  const { config, agent, agentBody, prompt } = input;

  // 1. Skills — `['*']` expands to every skill in the brain.
  const skillNames = agent.skills.includes("*")
    ? await listSkills(config.brain.path)
    : agent.skills;
  const skills = (
    await Promise.all(skillNames.map((s) => loadSkill(config.brain.path, s, config.brain.writable)))
  ).filter((s): s is NonNullable<typeof s> => s !== null);

  // 1a. Required-secrets check: if any loaded skill declares secrets it needs, verify they
  // resolve via env or the secrets backend before the LLM burns tokens.
  await assertSkillSecrets(config, skills);

  // 2. System prompt
  const system = await composeSystemPrompt({
    brainPath: config.brain.path,
    agent,
    agentBody,
    skills,
    identity: identityFromConfig(config),
    isSubagent: Boolean(input.isSubagent),
  });

  // 3. MCP servers (shared or fresh)
  const ownsMcp = !input.sharedMcp;
  let mcpServers = input.sharedMcp ?? new Map<string, ConnectedServer>();
  if (ownsMcp) {
    const allDefs = await loadMcpConfig(config.mcp.configPath);
    // Auto-inject the MemPalace HTTP MCP as the implicit "memory" server when
    // localHttp.enabled and no explicit memory/mempalace def exists. Mirrors the
    // container agent-turn path so `dae run` exercises the same memory wiring as
    // the live service — every agent gets memory by default.
    const lh = config.mempalace?.localHttp;
    if (lh?.enabled && !allDefs["memory"] && !allDefs["mempalace"]) {
      allDefs["memory"] = {
        url: `http://${lh.host}:${lh.port}${lh.urlPath}`,
        transport: "http",
        args: [],
        env: {},
        headers: {},
      };
    }
    // `mcpServers: ['*']` expands to every server in the mcp config.
    const expanded = agent.mcpServers.includes("*") ? Object.keys(allDefs) : agent.mcpServers;
    const wanted = new Set<string>(expanded);
    if (allDefs["memory"]) wanted.add("memory"); // every agent gets memory by default
    for (const name of wanted) {
      const def = allDefs[name];
      if (!def) {
        log.warn({ name }, "MCP server requested but not found in mcp config");
        continue;
      }
      try {
        const conn = await connectMcpServer(name, def);
        mcpServers.set(name, conn);
      } catch (err) {
        log.error({ name, err }, "MCP connection failed");
      }
    }
  } else if (input.sharedMcp) {
    // Filter to only those this agent declares. Wildcard means "take everything
    // the parent has connected" rather than what we'd have connected ourselves.
    const filtered = new Map<string, ConnectedServer>();
    const wanted = agent.mcpServers.includes("*")
      ? Array.from(input.sharedMcp.keys())
      : agent.mcpServers;
    for (const name of wanted) {
      const s = input.sharedMcp.get(name);
      if (s) filtered.set(name, s);
    }
    mcpServers = filtered;
  }

  // 4. Resolve the provider's API key from env / SecretsBackend / OneCLI placeholder.
  const secretsBackend = await buildSecretsBackend(config, { envFileBaseDir: process.cwd() });
  await resolveProviderKey(agent, config, secretsBackend);

  // 5. Provider, runtime, tools
  const provider = buildProvider(agent, config);
  const runtime = buildRuntime(agent, config);
  const builtinTools = selectBuiltins(agent.tools, config);

  // Subagents need a SessionStore so their memory + ask-user state persist across calls.
  // The `run` path is one-shot CLI invocation — open a SessionStore on the configured
  // path, with a fixed local user_id matching the cli channel.
  const sessions = new SessionStore(config.sessions.dbPath);
  const userId = sessions.resolveUser("cli", "local");
  const dispatcher = buildDispatcher(config);
  const orchestratorTool = await buildSpawnSubagentTool({
    config,
    parent: agent,
    sessions,
    userId,
    dispatcher,
  });
  if (orchestratorTool) builtinTools.push(orchestratorTool);

  // 5. Run
  const workspace = path.resolve(process.cwd());
  const kernel = new Kernel({
    provider,
    model: agent.model,
    system,
    builtinTools,
    mcpServers,
    toolContext: {
      runtime,
      brainPath: config.brain.path,
      brainWritable: config.brain.writable,
      workspacePath: workspace,
      agentName: agent.name,
      ...(config.runtime.shared.enabled
        ? {
            shared: {
              hostPath: config.runtime.shared.hostPath,
              containerPath: config.runtime.shared.containerPath,
            },
          }
        : {}),
    },
    maxTurns: agent.maxTurns,
    maxTokens: agent.maxTokens,
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
  });

  try {
    const result = await kernel.run(prompt);
    return { finalText: result.finalText, turns: result.turns };
  } finally {
    if (ownsMcp) {
      for (const s of mcpServers.values()) await s.close().catch(() => undefined);
    }
    sessions.close();
  }
}

async function assertSkillSecrets(
  config: ArtemisConfig,
  skills: Array<{ manifest: { name: string; requires: { secrets: string[] } } }>,
): Promise<void> {
  const needed = new Set<string>();
  for (const s of skills) {
    for (const n of s.manifest.requires.secrets) needed.add(n);
  }
  if (needed.size === 0) return;

  // Try process.env first (cheap), then the configured secrets backend.
  const missing: string[] = [];
  let backend: Awaited<ReturnType<typeof buildSecretsBackend>> | null = null;
  for (const n of needed) {
    if (process.env[n]) continue;
    if (!backend) {
      backend = await buildSecretsBackend(config, { envFileBaseDir: process.cwd() });
    }
    const v = await backend.get(n).catch(() => null);
    if (!v) missing.push(n);
    else process.env[n] = v; // hydrate for downstream tools (e.g. web_search Brave)
  }
  if (missing.length) {
    log.warn(
      { missing },
      `skill required secret(s) missing — agent will run but tools depending on them may fail. Save with \`dae secret save <NAME>\`.`,
    );
  }
}
