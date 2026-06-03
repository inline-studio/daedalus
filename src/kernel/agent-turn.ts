import path from "node:path";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import type { ArtemisConfig } from "../config/schema.js";
import type { Message, ToolUsePart, ToolResultPart } from "../types.js";
import { Kernel } from "./agent.js";
import { budgetTail, estimateTokens } from "./context-budget.js";
import { compactCompletedLoops } from "./history-compaction.js";
import { buildProvider } from "../providers/index.js";
import { buildRuntime } from "../runtime/factory.js";
import { selectBuiltins } from "../tools/registry.js";
import { askUserTool } from "../tools/ask-user.js";
import { composeSystemPrompt } from "../brain/composer.js";
import { loadSkill, listSkills } from "../brain/skills.js";
import { runSkillBootstraps } from "../brain/skill-bootstrap.js";
import { loadAgentCommands } from "../brain/commands.js";
import { loadAgent } from "../brain/agents.js";
import { resolveProviderKey } from "../providers/resolve.js";
import { buildSecretsBackend } from "../secrets/store/factory.js";
import { connectAgentMcp, McpPool } from "../mcp/agent-mcp.js";
import { autoSaveMemory } from "../memory/auto-save.js";
import { generateConversationTitle } from "../sessions/title.js";
import { SessionStore, type PersistedMessage } from "../sessions/store.js";
import { ScheduleStore } from "../sessions/schedule-store.js";
import { AttachmentStore } from "../attachments/store.js";
import { readAttachmentTool } from "../tools/attachment.js";
import { buildAttachReplyTool } from "../tools/attach-reply.js";
import { buildLoadSkillTool } from "../tools/load-skill.js";
import { buildSpawnSubagentTool } from "./orchestrator.js";
import { buildDispatcher } from "../dispatch/factory.js";
import type { AgentDispatcher, DispatchResult, OutboundAttachment } from "../dispatch/base.js";
import { log } from "../log.js";

// Single-turn agent runner. Invoked in two contexts:
//
//   1. In-process — by InProcessAgentDispatcher, inside the supervisor (host mode)
//      or the parent agent's container (subagent call landing back in-process).
//
//   2. In an agent container — by the `dae agent-turn` subcommand, where this is the
//      entire job of the container's lifetime: read session, run one kernel turn,
//      persist response, exit.
//
// The caller is responsible for having already appended the user's message that
// triggered this turn (or the tool_result that answers a pending ask_user) to the
// session before invoking us.
export interface RunAgentTurnInput {
  config: ArtemisConfig;
  agentName: string;
  sessionId: string;
  userId: string;
  isSubagent: boolean;
  // When set (the long-lived agent-worker), MCP connections are taken from this
  // persistent pool and kept open across turns. When omitted (the one-shot
  // `dae agent-turn` container), we connect fresh and close at the end of the turn.
  mcpPool?: McpPool;
}

export async function runAgentTurn(input: RunAgentTurnInput): Promise<DispatchResult> {
  const { config, agentName, sessionId, userId, isSubagent } = input;

  // 1. Load the agent manifest + body from the brain.
  const loaded = await loadAgent(config.brain.path, agentName);
  const agent = loaded.manifest;
  const agentBody = loaded.body;

  // 2. Open the session store. In docker mode the sqlite file is on a mounted
  // volume shared with the supervisor; reading + writing here is the same DB.
  const sessions = new SessionStore(config.sessions.dbPath);
  const scheduleStore = new ScheduleStore(config.sessions.dbPath);
  try {
    const attachments = new AttachmentStore(config.sessions.attachmentsPath);
    await attachments.ensureDir();

    // 3. Skills + system prompt
    // `skills: ['*']` expands to every skill in the brain — convenient for an
    // orchestrator. `[]` (omitted / explicit empty) means no skills; subagent
    // default.
    const skillNames = agent.skills.includes("*")
      ? await listSkills(config.brain.path)
      : agent.skills;
    const skills = (
      await Promise.all(
        skillNames.map((s) => loadSkill(config.brain.path, s, config.brain.writable)),
      )
    ).filter((s): s is NonNullable<typeof s> => s !== null);
    await hydrateSkillSecrets(config, skills);
    // Each skill with a bootstrap.sh gets one chance to install its binaries
    // into the shared skill-bin dir on PATH. Idempotent + content-hashed —
    // only re-runs if the script changes.
    const dataDir = path.dirname(config.sessions.dbPath);
    await runSkillBootstraps(skills, dataDir);

    // Slash-commands available to this agent (per manifest's commands:).
    // Subagents typically don't have any, so this is usually empty on the
    // subagent-dispatch path.
    const commands = await loadAgentCommands(config.brain.path, agent.commands);

    const system = await composeSystemPrompt({
      brainPath: config.brain.path,
      agent,
      agentBody,
      skills,
      commands,
      identity: config.identity.nickname
        ? { name: config.identity.name, nickname: config.identity.nickname }
        : { name: config.identity.name },
      isSubagent,
    });

    // 4. Resolve provider API key and build the provider client.
    const secretsBackend = await buildSecretsBackend(config, { envFileBaseDir: process.cwd() });
    await resolveProviderKey(agent, config, secretsBackend);
    const provider = buildProvider(agent, config);

    // 5. Runtime for tool exec. In docker mode this is the agent's own container,
    // so HostRuntime runs commands locally inside the container. Per-agent docker
    // bind/network overrides still apply via the manifest's container block.
    const runtime = buildRuntime(agent, config);

    // 6. MCP — connect everything this agent declares + auto-injected memory MCP.
    // In docker mode these are typically HTTP endpoints reachable on the shared
    // docker network (e.g. http://mempalace:11364/mcp). The warm worker reuses a
    // persistent pool; the one-shot container connects fresh and owns teardown.
    const ownsMcp = !input.mcpPool;
    const mcpServers = input.mcpPool
      ? await input.mcpPool.getForAgent(config, agent.mcpServers)
      : await connectAgentMcp(config, agent.mcpServers);

    // 7. Build built-in tools strictly per the manifest. Empty list = no tools
    // (was previously "all" — that was a security footgun for subagents).
    // Scheduling tools (schedule_message / cancel / list) need the schedule
    // store; pass it through deps.
    const builtinTools = selectBuiltins(agent.tools, config, { scheduleStore });
    builtinTools.push(readAttachmentTool(attachments));
    // Outbound reply attachments. Only the top-level turn's reply reaches the user, so
    // only it gets `attach_to_reply`; the tool records refs into this sink which we
    // return in the DispatchResult below.
    const outboundAttachments: OutboundAttachment[] = [];
    if (!isSubagent) {
      builtinTools.push(buildAttachReplyTool(attachments, outboundAttachments));
    }
    // Progressive skill disclosure: the system prompt carries only a skill MENU
    // (name + summary). Give the agent the means to pull a full body on demand.
    if (skills.length) builtinTools.push(buildLoadSkillTool(skills));
    if (isSubagent) {
      // Subagents get ask_user so they can bubble questions up to the orchestrator.
      builtinTools.push(askUserTool);
    }

    // Subagent spawning. Subagents themselves can spawn further subagents IF
    // their manifest declares any.
    const dispatcher: AgentDispatcher = buildDispatcher(config);
    const orchestratorTool = await buildSpawnSubagentTool({
      config,
      parent: agent,
      sessions,
      userId,
      dispatcher,
    });
    if (orchestratorTool) builtinTools.push(orchestratorTool);

    // 8. Read history tail and run kernel. If an explicit token budget is configured we
    // trim the loaded tail to it up front; otherwise we send the full count-limited tail
    // and let the kernel's reactive on-overflow handling adapt to the model's actual
    // window (we don't bake a context-size assumption into daedalus).
    const tail = sessions.tail(sessionId, config.sessions.historyLimit);
    const full = await prepareMessagesForTurn(tail);
    // Compact older completed turn-loops: replace bulky tool_result bodies with stubs once
    // the agent has emitted a final text summary for that loop. Keeps the N most recent loops
    // at full fidelity. Persisted history is untouched — this is a replay-time view.
    const keep = config.sessions.keepFullFidelityLoops;
    const compacted = keep > 0 ? compactCompletedLoops(full, { keepFullFidelityLoops: keep }) : full;
    const budget = config.sessions.contextTokenBudget;
    const messages = budget ? budgetTail(compacted, budget) : compacted;
    if (budget && messages.length < full.length) {
      log.info(
        { from: full.length, to: messages.length, budget },
        "history trimmed to token budget",
      );
    }

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
        workspacePath: path.resolve(process.cwd()),
        agentName: agent.name,
        ...(config.runtime.shared.enabled
          ? {
              shared: {
                hostPath: config.runtime.shared.hostPath,
                containerPath: config.runtime.shared.containerPath,
              },
            }
          : {}),
        // Shared skill-bin dir — same path inside the agent container as on the
        // host (mounted via /data → /data). bash tool prepends this to $PATH.
        skillBinDir: {
          hostPath: path.join(dataDir, "skill-bin"),
          containerPath: "/data/skill-bin",
        },
      },
      maxTurns: agent.maxTurns,
      maxTokens: agent.maxTokens,
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.vision ? { vision: agent.vision } : {}),
    });

    // Per-turn context-size breakdown — helps right-size what we send to the model. Image/file
    // parts are bounded (vision tokens / sha256 refs) rather than counted by their byte length,
    // so we estimate text-heavy components by char count (~4 chars/token) and non-text parts
    // as a small flat 64.
    const tok = (n: number) => Math.ceil(n / 4);
    const sysChars = system.length;
    const builtinChars = JSON.stringify(builtinTools).length;
    let mcpToolCount = 0;
    let mcpChars = 0;
    for (const server of mcpServers.values()) {
      const tools = (server as { tools?: unknown[] }).tools ?? [];
      mcpToolCount += tools.length;
      try {
        mcpChars += JSON.stringify(tools).length;
      } catch {
        /* unstringifiable — skip */
      }
    }
    // Reuse the kernel's own estimateTokens so tool_use (name + JSON input) and tool_result
    // (full content) parts are counted properly. The original flat-64-per-non-text under-counted
    // history by ~10x in tool-heavy sessions (the dominant chunk in this agent's prompts).
    let historyTokens = 0;
    for (const m of messages) historyTokens += estimateTokens(m.content);
    // Track what compaction + budget trimming saved, so the impact is visible.
    let fullTokens = 0;
    for (const m of full) fullTokens += estimateTokens(m.content);
    log.info(
      {
        agent: agent.name,
        system: tok(sysChars),
        builtinTools: { count: builtinTools.length, est: tok(builtinChars) },
        mcp: { servers: mcpServers.size, tools: mcpToolCount, est: tok(mcpChars) },
        history: {
          msgs: messages.length,
          est: historyTokens,
          ...(fullTokens > historyTokens ? { savedByCompaction: fullTokens - historyTokens } : {}),
        },
        estTotal: tok(sysChars + builtinChars + mcpChars) + historyTokens,
      },
      "context breakdown (estimated tokens, ~4 chars/token)",
    );

    // Authoritative dump of EVERYTHING we're handing the model — system prompt, every tool
    // definition (built-in + MCP), and the full messages array. Overwritten each turn (latest
    // only, bounded disk) and only the path is logged so docker compose logs stay readable.
    // Inspect with: `docker compose exec dae-worker sh -lc 'cat /tmp/dae-context-<agent>.json'`
    // (or `| jq` for structure). This is the empirical answer to "what's actually being sent?"
    // instead of an estimate.
    const dumpPath = path.join(os.tmpdir(), `dae-context-${agent.name}.json`);
    try {
      const mcpToolDefs: Array<{ server: string; tools: unknown }> = [];
      for (const [name, server] of mcpServers) {
        mcpToolDefs.push({ server: name, tools: (server as { tools?: unknown }).tools ?? null });
      }
      await writeFile(
        dumpPath,
        JSON.stringify(
          {
            agent: agent.name,
            historyLimitInConfig: config.sessions.historyLimit,
            contextTokenBudgetInConfig: config.sessions.contextTokenBudget ?? null,
            system,
            builtinTools: builtinTools.map((t) => t.definition),
            mcpTools: mcpToolDefs,
            messages,
          },
          null,
          2,
        ),
      );
      log.info({ path: dumpPath }, "wrote full context to file (the actual prompt sent)");
    } catch (err) {
      log.warn({ err: (err as Error).message }, "context dump failed");
    }

    const result = await kernel.runWithMessages(messages);

    // 9. Persist whatever the kernel produced beyond the existing tail. Skip a
    // content-less, tool-less assistant message (e.g. the model returned an empty
    // completion) — replaying one later makes the provider reject the whole request
    // ("assistant message must contain content or tool_calls"), poisoning the session.
    const newMessages = result.messages.slice(messages.length);
    for (const m of newMessages) {
      if (isEmptyAssistantMessage(m)) continue;
      sessions.appendMessage({ sessionId, role: m.role, content: m.content });
    }

    // 9b. Deterministic memory auto-save. After a TOP-LEVEL turn completes (not a subagent,
    // and not while a question is pending), distil any durable facts from the turn and write
    // them to the memory backend. This runs WHILE the memory MCP is still connected (before
    // the teardown below) and is fully best-effort — it never affects the reply we return.
    // Subagents are excluded: their findings flow up to the orchestrator's turn, which is
    // where the user-facing memory-worthy outcome actually lands.
    if (
      config.memory.autoSave.enabled &&
      !isSubagent &&
      !result.pendingQuestion &&
      mcpServers.has("memory")
    ) {
      try {
        await autoSaveMemory({
          provider,
          model: config.memory.autoSave.model ?? agent.model,
          mcpServers,
          // The trigger + everything the kernel produced this turn.
          messages: result.messages.slice(messages.length - 1),
          agentName: agent.name,
          maxFactsPerTurn: config.memory.autoSave.maxFactsPerTurn,
        });
      } catch (err) {
        log.warn({ err: (err as Error).message }, "auto-save: unexpected failure (ignored)");
      }
    }

    // 9c. Model-generated conversation title (web conversations). After the FIRST exchange in a
    // brand-new, non-default conversation, ask the model for a short topical title and replace
    // the provisional first-message snippet. Gated to the first exchange (no prior assistant
    // message) so it runs exactly once per conversation, and skipped for the default ("Main")
    // session (whose web label is fixed and which other channels share). Best-effort: a failure
    // leaves the provisional title untouched and never affects the reply.
    if (config.sessions.autoTitle && !isSubagent && !result.pendingQuestion) {
      try {
        const priorAssistantCount = messages.filter((m) => m.role === "assistant").length;
        if (priorAssistantCount === 0) {
          const def = sessions.getOrCreateSession(userId, agentName);
          if (sessionId !== def.id) {
            const title = await generateConversationTitle({
              provider,
              model: agent.model,
              // The triggering user message + everything the kernel produced this turn.
              messages: result.messages.slice(messages.length - 1),
            });
            if (title) sessions.setSessionTitle(sessionId, title);
          }
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, "conversation-title: unexpected failure (ignored)");
      }
    }

    // Tear down MCP connections we opened. When running under the warm worker the
    // connections come from a persistent pool the worker owns — leave them open.
    if (ownsMcp) {
      for (const s of mcpServers.values()) {
        await s.close().catch(() => undefined);
      }
    }

    if (result.pendingQuestion) {
      return {
        status: "pending_question",
        question: result.pendingQuestion.question,
        turns: result.turns,
        ...(result.notices?.length ? { notices: result.notices } : {}),
      };
    }
    return {
      status: "complete",
      finalText: result.finalText,
      turns: result.turns,
      ...(outboundAttachments.length ? { attachments: outboundAttachments } : {}),
      ...(result.notices?.length ? { notices: result.notices } : {}),
    };
  } finally {
    sessions.close();
    scheduleStore.close();
  }
}

// Tail conversion + resume-from-ask_user wiring. If the most recent assistant
// message ends in an unanswered ask_user, the tail already contains a user-side
// tool_result appended by the caller — we just feed everything to the kernel.
async function prepareMessagesForTurn(tail: PersistedMessage[]): Promise<Message[]> {
  return tail
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}

// Convenience: the agent-turn entrypoint expects the latest persisted user message
// to be the trigger for this turn. If a previous assistant message had an open
// ask_user tool_use, callers should have already appended a tool_result before
// invoking us — that's the resume path.
//
// Exported so callers (supervisor's ingest path; subagent dispatchers) can use the
// same logic to detect pending questions consistently.
export function findPendingAskUser(
  messages: Message[],
): { toolUseId: string } | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1]!;
  if (last.role !== "assistant") return null;
  const askUse = last.content.find(
    (c): c is ToolUsePart => c.type === "tool_use" && c.name === "ask_user",
  );
  return askUse ? { toolUseId: askUse.id } : null;
}

// Build a user message wrapping a tool_result for an open ask_user. Used by the
// subagent-resume path: the parent's response to the question becomes the answer.
// An assistant message with no tool_use and no non-whitespace text is a no-op the LLM
// providers reject when it's replayed ("assistant message must contain content or
// tool_calls"). We never persist one, so a stray empty completion can't poison a session.
export function isEmptyAssistantMessage(m: Message): boolean {
  if (m.role !== "assistant") return false;
  if (m.content.some((c) => c.type === "tool_use")) return false;
  const text = m.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
  return text.length === 0;
}

export function buildResumeMessage(toolUseId: string, answer: string): Message {
  const part: ToolResultPart = {
    type: "tool_result",
    toolUseId,
    content: answer,
  };
  return { role: "user", content: [part] };
}

async function hydrateSkillSecrets(
  config: ArtemisConfig,
  skills: Array<{ manifest: { name: string; requires: { secrets: string[] } } }>,
): Promise<void> {
  const needed = new Set<string>();
  for (const s of skills) for (const n of s.manifest.requires.secrets) needed.add(n);
  if (needed.size === 0) return;
  const missing: string[] = [];
  let backend: Awaited<ReturnType<typeof buildSecretsBackend>> | null = null;
  for (const n of needed) {
    if (process.env[n]) continue;
    if (!backend) backend = await buildSecretsBackend(config, { envFileBaseDir: process.cwd() });
    const v = await backend.get(n).catch(() => null);
    if (!v) missing.push(n);
    else process.env[n] = v;
  }
  if (missing.length) log.warn({ missing }, "skill secrets missing");
}
