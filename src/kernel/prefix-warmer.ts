import type { ArtemisConfig } from "../config/schema.js";
import type { LLMProvider } from "../providers/base.js";
import { assembleAgentCore, assembleTurnTools } from "./agent-turn.js";
import { mergeToolDefs } from "./agent.js";
import { SessionStore } from "../sessions/store.js";
import { ScheduleStore } from "../sessions/schedule-store.js";
import { AttachmentStore } from "../attachments/store.js";
import { AttachmentIndexStore } from "../attachments/index-store.js";
import { SkillLearningStore } from "../sessions/skill-learning-store.js";
import { log } from "../log.js";

// Prompt-prefix warmer. Self-hosted llama.cpp keeps prompt cache state in RAM, but a NEW
// conversation can only reuse it if the pool holds a state restorable at (or below) the
// shared prefix boundary — i.e. system prompt + tool definitions. Long conversations age
// their restore points far past that boundary (measured: the first message after a quiet
// stretch on a hybrid Mamba-Transformer logged "forcing full prompt re-processing" and
// re-prefilled ~13k tokens, ~16 s; a fresh single-turn state brought a different first
// message down to ~0.4 s). So: periodically replay each front-door agent's EXACT turn
// prefix as a one-token completion. Re-warming an already-cached prefix costs the backend
// almost nothing; a warm after eviction/restart pays the prefill once, off anyone's
// critical path.
//
// Byte-identity is the whole game — the system prompt AND the tool-definition list
// (content + order) must match a real top-level turn, which is why this reuses
// assembleAgentCore/assembleTurnTools/mergeToolDefs instead of composing its own request.

export interface WarmResult {
  agent: string;
  ok: boolean;
  ms: number;
  error?: string;
}

// A user id has to exist for tool construction (find_attachment etc. close over it), but
// the warm request never executes tools, so any stable value works.
const WARMER_USER_ID = "prefix-warmer";

const WARM_MESSAGE =
  "(automated cache warm-up ping — not a real user. Reply with a single character.)";

export async function warmAgentPrefix(
  config: ArtemisConfig,
  agentName: string,
  overrides?: { provider?: LLMProvider },
): Promise<WarmResult> {
  const started = Date.now();
  // Mirror runAgentTurn's store gating exactly — which stores exist decides which tools
  // get built, and the tool list is part of the prefix being warmed.
  const sessions = new SessionStore(config.sessions.dbPath);
  const scheduleStore = new ScheduleStore(config.sessions.dbPath);
  const attachmentIndex = config.sessions.attachmentIndex.enabled
    ? new AttachmentIndexStore(config.sessions.dbPath)
    : undefined;
  const skillLearning = config.skills.learning.enabled
    ? new SkillLearningStore(config.sessions.dbPath)
    : undefined;
  let mcpServers: Awaited<ReturnType<typeof assembleTurnTools>>["mcpServers"] | undefined;
  try {
    const attachments = new AttachmentStore(config.sessions.attachmentsPath);
    await attachments.ensureDir();

    const core = await assembleAgentCore(config, agentName, false);
    const tools = await assembleTurnTools({
      config,
      agent: core.agent,
      skills: core.skills,
      isSubagent: false,
      userId: WARMER_USER_ID,
      sessions,
      scheduleStore,
      attachments,
      ...(attachmentIndex ? { attachmentIndex } : {}),
      ...(skillLearning ? { skillLearning } : {}),
    });
    mcpServers = tools.mcpServers;

    const provider = overrides?.provider ?? core.provider;
    await provider.complete({
      system: core.system,
      messages: [{ role: "user", content: [{ type: "text", text: WARM_MESSAGE }] }],
      tools: mergeToolDefs(tools.builtinTools, tools.mcpServers),
      model: core.agent.model,
      maxTokens: 1,
    });
    const ms = Date.now() - started;
    log.info({ agent: agentName, ms }, "prefix warm complete");
    return { agent: agentName, ok: true, ms };
  } catch (err) {
    const ms = Date.now() - started;
    const error = (err as Error).message;
    log.warn({ agent: agentName, ms, error }, "prefix warm failed (ignored)");
    return { agent: agentName, ok: false, ms, error };
  } finally {
    // The warmer always owns its MCP connections (no pool is passed), so always close.
    if (mcpServers) {
      for (const s of mcpServers.values()) await s.close().catch(() => undefined);
    }
    sessions.close();
    scheduleStore.close();
    attachmentIndex?.close();
    skillLearning?.close();
  }
}

// warming.agents when set; otherwise every enabled channel's defaultAgent — the prefixes
// a user's first message would actually hit.
export function resolveWarmAgents(config: ArtemisConfig): string[] {
  if (config.warming.agents.length) return [...new Set(config.warming.agents)];
  const out = new Set<string>();
  for (const ch of Object.values(config.channels)) {
    if (ch && typeof ch === "object" && "enabled" in ch && ch.enabled && "defaultAgent" in ch) {
      out.add((ch as { defaultAgent: string }).defaultAgent);
    }
  }
  return [...out];
}

export interface PrefixWarmerHandle {
  stop(): void;
  // The in-flight/last cycle, for tests and the CLI one-shot path.
  current: Promise<WarmResult[]> | undefined;
}

export function startPrefixWarmer(config: ArtemisConfig): PrefixWarmerHandle {
  const agents = resolveWarmAgents(config);
  let timer: ReturnType<typeof setInterval> | undefined;
  const handle: PrefixWarmerHandle = {
    stop: () => {
      if (timer) clearInterval(timer);
    },
    current: undefined,
  };
  if (!agents.length) {
    log.warn("prefix warmer enabled but no agents resolved (no warming.agents, no enabled channels)");
    return handle;
  }

  let running = false;
  const cycle = async (): Promise<WarmResult[]> => {
    // Serialize cycles: a cold warm of a big model can take longer than a short interval.
    if (running) return [];
    running = true;
    try {
      const results: WarmResult[] = [];
      for (const agent of agents) results.push(await warmAgentPrefix(config, agent));
      return results;
    } finally {
      running = false;
    }
  };

  timer = setInterval(() => {
    handle.current = cycle();
  }, config.warming.intervalMinutes * 60_000);
  // Don't let the warmer alone keep a shutting-down process alive.
  timer.unref?.();
  if (config.warming.onStart) handle.current = cycle();
  log.info(
    { agents, intervalMinutes: config.warming.intervalMinutes },
    "prefix warmer armed",
  );
  return handle;
}
