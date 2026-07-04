import path from "node:path";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import type { ArtemisConfig } from "../config/schema.js";
import type { Message, ToolUsePart, ToolResultPart, TurnEventSink } from "../types.js";
import { Kernel, summarizeConversation } from "./agent.js";
import { budgetTail, estimateTokens } from "./context-budget.js";
import { compactCompletedLoops } from "./history-compaction.js";
import { buildProvider } from "../providers/index.js";
import type { LLMProvider } from "../providers/base.js";
import { inferContextWindow } from "../providers/model-info.js";
import { buildRuntime } from "../runtime/factory.js";
import { RemoteRuntime } from "../runtime/remote.js";
import { selectBuiltins } from "../tools/registry.js";
import { askUserTool } from "../tools/ask-user.js";
import { composeSystemPrompt } from "../brain/composer.js";
import { appendNowToLastUserMessage } from "../brain/now.js";
import { loadSkill, listSkills } from "../brain/skills.js";
import { runSkillBootstraps } from "../brain/skill-bootstrap.js";
import { loadAgentCommands, detectSlashCommand } from "../brain/commands.js";
import { loadAgent } from "../brain/agents.js";
import { resolveProviderKey } from "../providers/resolve.js";
import { buildSecretsBackend } from "../secrets/store/factory.js";
import { connectAgentMcp, McpPool } from "../mcp/agent-mcp.js";
import { autoSaveMemory } from "../memory/auto-save.js";
import { runSkillReview, shouldRunSkillReview } from "../brain/skill-review.js";
import { SkillLearningStore } from "../sessions/skill-learning-store.js";
import { generateConversationTitle } from "../sessions/title.js";
import { SessionStore, COMPACTION_CHANNEL, type PersistedMessage } from "../sessions/store.js";
import { ConversationLog } from "../sessions/conversation-log.js";
import { ScheduleStore } from "../sessions/schedule-store.js";
import { AttachmentStore } from "../attachments/store.js";
import { AttachmentIndexStore } from "../attachments/index-store.js";
import { readAttachmentTool } from "../tools/attachment.js";
import { findAttachmentTool, describeAttachmentTool } from "../tools/find-attachment.js";
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
  // Origin identity of the user this turn runs on behalf of (channel + external
  // id the inbound arrived on). Surfaced to tools via ToolContext so future
  // deliveries (schedule_message) route back to the real user. Optional —
  // synthetic paths may omit them.
  originChannel?: string;
  originExternalUserId?: string;
  // When set (the long-lived agent-worker), MCP connections are taken from this
  // persistent pool and kept open across turns. When omitted (the one-shot
  // `dae agent-turn` container), we connect fresh and close at the end of the turn.
  mcpPool?: McpPool;
  // Live turn-event sink. Set only on the in-process path (a function can't cross the
  // container/worker serialization hop); when present and the provider supports streaming, the
  // kernel emits token-level events as the turn unfolds.
  onEvent?: TurnEventSink;
  // Ephemeral skill-trigger directive — injected into the model's view of the last user message
  // for this turn only, never persisted. See IngestResult.turnDirective.
  turnDirective?: string;
  // Remote execution (`dae remote` / desktop executor): when set, this turn's bash +
  // read/write/edit run on the user's machine via the supervisor's /rpc/exec bridge.
  // Set for top-level turns whose user has a connected executor, and threaded into
  // sub-agents that declare `execution: executor`. `env` describes the machine for the
  // execution-environment context line.
  remoteExec?: { userId: string; url: string; token: string; executorId?: string; env?: Record<string, string> };
  // Abort signal for the whole turn (the user's Stop button). In-process path only — a
  // signal can't cross the container/worker hop; those get aborted at their own layer.
  signal?: AbortSignal;
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
  // Per-user attachment catalogue (find_attachment / describe_attachment). Only the
  // top-level agent gets these tools, but the store is opened unconditionally when enabled
  // and closed in finally; building the tools is gated below.
  const attachmentIndex = config.sessions.attachmentIndex.enabled
    ? new AttachmentIndexStore(config.sessions.dbPath)
    : undefined;
  // Skill self-learning state (usage timestamps for the curator + the cross-turn nudge
  // counter). Opened only when the feature is on; closed in finally.
  const skillLearning = config.skills.learning.enabled
    ? new SkillLearningStore(config.sessions.dbPath)
    : undefined;
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
        skillNames.map((s) => loadSkill(config.brain.path, s)),
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

    // 4b. Built-in /compact — user-triggered persistent compaction, any channel. Handled
    // here, before the runtime/MCP/tool setup none of which a summarise needs, and
    // short-circuits the turn: summarise everything since the last marker, persist a reply
    // plus a fresh compaction marker, and return. A brain-defined commands/compact.md takes
    // precedence: ingest expands it into a preamble, so the raw "/compact" text below never
    // matches and the turn runs normally.
    if (!isSubagent) {
      const trigger = sessions.tail(sessionId, 1)[0];
      const compact = trigger ? detectCompactCommand(trigger) : null;
      if (compact) {
        const finalText = await runCompactCommand({
          provider,
          model: agent.model,
          sessions,
          sessionId,
          historyLimit: config.sessions.historyLimit,
          focus: compact.focus,
        });
        return { status: "complete", finalText, turns: 0 };
      }
    }

    // 5. Runtime for tool exec. In docker mode this is the agent's own container,
    // so HostRuntime runs commands locally inside the container. Per-agent docker
    // bind/network overrides still apply via the manifest's container block.
    // Remote execution overrides everything: when the originating user has a `dae remote`
    // executor connected, this turn's tools run on THEIR machine via the bridge.
    const runtime = input.remoteExec
      ? new RemoteRuntime(input.remoteExec)
      : buildRuntime(agent, config);

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
      // Cross-session attachment recall. Top-level only: a subagent's findings flow up
      // through the orchestrator, which owns the conversation with the user.
      if (attachmentIndex) {
        builtinTools.push(findAttachmentTool(attachmentIndex, userId));
        builtinTools.push(describeAttachmentTool(attachmentIndex, userId));
      }
    }
    // Progressive skill disclosure: the system prompt carries only a skill MENU
    // (name + summary). Give the agent the means to pull a full body on demand.
    // When skill learning is on, every load bumps the usage tracker the curator reads.
    if (skills.length) {
      builtinTools.push(
        buildLoadSkillTool(skills, skillLearning ? (s) => skillLearning.recordUse(s) : undefined),
      );
    }
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
      // Forward this turn's live sink so delegated work streams to the user. The
      // wrapper in spawn_subagent re-tags subagent events with their origin.
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
      // The executor grant, for sub-agents that declare `execution: executor`.
      ...(input.remoteExec ? { remoteExec: input.remoteExec } : {}),
    });
    if (orchestratorTool) builtinTools.push(orchestratorTool);

    // 8. Read history tail and run kernel. If an explicit token budget is configured we
    // trim the loaded tail to it up front; otherwise we send the full count-limited tail
    // and let the kernel's reactive on-overflow handling adapt to the model's actual
    // window (we don't bake a context-size assumption into daedalus).
    const tail = applyCompactionCut(sessions.tail(sessionId, config.sessions.historyLimit));
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

    // Time context rides on the latest user turn rather than the system prompt, so the system
    // prompt + tool definitions stay byte-identical across requests and the backend reuses their
    // KV cache (a fresh timestamp in the system prefix forces a full cold re-prefill every turn).
    // In place: doesn't grow the array (the new-message slice below stays correct) and isn't
    // persisted to session history.
    appendNowToLastUserMessage(messages, {
      timeAware: agent.timeAware,
      ...(agent.timezone ? { timezone: agent.timezone } : {}),
    });

    // Execution-environment context (WS7): when this turn's tools run on the user's
    // machine, say so — the model must stop assuming the server container's toolchain
    // and probe (`command -v`) where it matters. Same ephemeral in-place mechanism as
    // the time context: model-visible this turn only, never persisted.
    if (input.remoteExec) {
      const env = input.remoteExec.env ?? {};
      const where = [env.hostname, env.platform && env.arch ? `${env.platform}/${env.arch}` : env.platform]
        .filter(Boolean)
        .join(", ");
      const line =
        `# Execution environment\n` +
        `bash/read/write/edit run on the USER'S machine${where ? ` (${where})` : ""}` +
        `${env.workspace ? `, workspace ${env.workspace}` : ""} — NOT the server container. ` +
        `The server's skills-installed binaries and /shared paths do not apply here; probe ` +
        "with `command -v` before relying on a tool.";
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") {
          messages[i]!.content.push({ type: "text", text: line });
          break;
        }
      }
    }

    // Ephemeral skill-trigger directive: prepend the matched skill's instructions to the model's
    // view of the last user message for THIS turn only (not persisted — see IngestResult). This
    // is what makes the agent act on a triggered skill without dumping the skill body into the
    // stored/displayed conversation or re-sending it on every later turn.
    if (input.turnDirective) {
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]!.role === "user") {
          messages[i] = {
            role: "user",
            content: [{ type: "text", text: input.turnDirective }, ...messages[i]!.content],
          };
          break;
        }
      }
    }

    const toolContext = {
      runtime,
      brainPath: config.brain.path,
      brainWritable: config.brain.writable,
      workspacePath: path.resolve(process.cwd()),
      agentName: agent.name,
      ...(input.originChannel ? { originChannel: input.originChannel } : {}),
      ...(input.originExternalUserId
        ? { originExternalUserId: input.originExternalUserId }
        : {}),
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
    };
    const kernel = new Kernel({
      provider,
      model: agent.model,
      system,
      builtinTools,
      mcpServers,
      toolContext,
      maxTurns: agent.maxTurns,
      maxTokens: agent.maxTokens,
      ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
      ...(agent.thinking.enabled
        ? { thinking: { budgetTokens: agent.thinking.budgetTokens } }
        : {}),
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
    const mcpToolDefs: Array<{ server: string; tools: unknown }> = [];
    for (const [name, server] of mcpServers) {
      mcpToolDefs.push({ server: name, tools: (server as { tools?: unknown }).tools ?? null });
    }
    const dumpPath = path.join(os.tmpdir(), `dae-context-${agent.name}.json`);
    try {
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

    // Context readout enrichment: the kernel reports how many input tokens the final
    // completion carried; we add the model's window (manifest override → family inference)
    // so the UI can show a percentage. Unknown window → the readout stays a plain count.
    const contextWindow = agent.contextWindow ?? inferContextWindow(agent.model);
    const onEvent: TurnEventSink | undefined =
      input.onEvent && contextWindow
        ? (ev) =>
            input.onEvent!(
              ev.type === "turn_complete" && ev.context
                ? { ...ev, context: { ...ev.context, window: contextWindow } }
                : ev,
            )
        : input.onEvent;
    const result = await kernel.runWithMessages(messages, input.signal, onEvent);

    // 9. Persist whatever the kernel produced beyond the existing tail. Skip a
    // content-less, tool-less assistant message (e.g. the model returned an empty
    // completion) — replaying one later makes the provider reject the whole request
    // ("assistant message must contain content or tool_calls"), poisoning the session.
    const newMessages = result.messages.slice(messages.length);
    for (const m of newMessages) {
      if (isEmptyAssistantMessage(m)) continue;
      sessions.appendMessage({ sessionId, role: m.role, content: m.content });
    }

    // 9-bis. Conversation debug log (opt-in via config.debug.conversationLog). Append this
    // turn's COMPLETE exchange — every tool_use + tool_result the kernel produced — to a
    // retained JSONL trace. This is the record that answers "did the agent actually run that
    // tool, or fabricate the result?". Logged for top-level AND subagent turns (the real work
    // often happens in a subagent); the path is only SURFACED for the top-level turn, below.
    // Fully best-effort: a logging failure never affects the reply.
    let debugLogPath: string | undefined;
    const dbgLog = config.debug.conversationLog;
    if (dbgLog.enabled) {
      const written = await new ConversationLog(dbgLog.path, dbgLog.retentionDays).append({
        ts: new Date().toISOString(),
        agent: agent.name,
        sessionId,
        model: agent.model,
        isSubagent,
        turns: result.turns,
        stopReason: result.stopReason,
        ...(result.usage ? { usage: result.usage } : {}),
        exchange: newMessages,
        finalText: result.finalText,
        ...(result.notices?.length ? { notices: result.notices } : {}),
        // The full input handed to the model this turn — system prompt + every tool def + the
        // replayed history (image base64 elided) — so the log answers "what was actually sent,
        // and why is the prompt this big?".
        input: {
          system,
          tools: { builtin: builtinTools.map((t) => t.definition), mcp: mcpToolDefs },
          messages: elideImageData(messages),
        },
      });
      if (written) debugLogPath = written;
    }
    // Surface the debug-log pointer as activity chrome (a live event), not a separate chat
    // message — the same treatment as tool/reasoning. Top-level + streaming only; buffered
    // channels (Telegram) don't render chrome, so it's simply not shown there.
    if (debugLogPath && !isSubagent) input.onEvent?.({ type: "debug_log", path: debugLogPath });

    // Surface this turn's reasoning to the user as its own messages (the persona "thinking out
    // loud"), when the agent opts in. Top-level only — a subagent's thinking flows up through the
    // orchestrator's own turn, not straight to the user. Prepended ahead of any kernel notices so
    // the order the user sees is: thinking → notices → reply.
    // Thinking is surfaced two ways depending on the channel: streamed inline as it happens (the
    // kernel's thinking events → web/CLI), OR — for buffered channels that can't render inline
    // (Telegram) — as separate "💭" messages. We return it SEPARATELY from system notices so the
    // delivery layer (serve) can drop it on streaming channels, where it's already shown inline,
    // and avoid the double render.
    const thinkingMessages =
      agent.thinking.surface && !isSubagent ? collectThinkingMessages(newMessages) : [];
    const notices = result.notices ?? [];

    // 9a. Persist the compaction. The kernel's in-turn summarise/drop only shrank what was
    // SENT this turn — the session still holds the full history, so without a persisted cut
    // every later turn reloads it and overflows again. Summarise the complete final message
    // list (so nothing the marker cuts off is unaccounted for) and append it as a marker;
    // applyCompactionCut starts later turns' context there. Best-effort: a summarise failure
    // just means the next turn pays the reactive path again.
    if (result.compacted) {
      try {
        const summary = await summarizeConversation(provider, agent.model, result.messages);
        if (summary) {
          persistCompactionMarker(sessions, sessionId, summary);
          log.info({ sessionId }, "compaction marker persisted");
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, "compaction marker failed (ignored)");
      }
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

    // 9b-ter. Skill self-learning review. After a substantial TOP-LEVEL turn, a small fork
    // replays the transcript with only the skill_manage tool and patches/creates skills
    // (the procedures counterpart to the memory auto-save above). Gated on the turn being
    // worth reviewing — enough tool calls, a skill in play, or the session nudge counter —
    // so trivial turns don't pay an extra model call. Fully best-effort.
    if (skillLearning && !isSubagent && !result.pendingQuestion && config.brain.writable) {
      try {
        const toolCalls = countToolUses(newMessages);
        const skillLoaded = newMessages.some(
          (m) =>
            m.role === "assistant" &&
            m.content.some((p) => p.type === "tool_use" && p.name === "load_skill"),
        );
        const nudgeTotal = toolCalls > 0 ? skillLearning.addToolCalls(sessionId, toolCalls) : 0;
        if (shouldRunSkillReview(config.skills.learning, { toolCalls, skillLoaded, nudgeTotal })) {
          const review = await runSkillReview({
            config,
            provider,
            model: config.skills.learning.model ?? agent.model,
            messages: result.messages.slice(messages.length - 1),
            toolContext,
          });
          // A real write means the learning debt is paid — restart the cross-turn counter.
          if (review.wrote) skillLearning.resetNudge(sessionId);
        }
      } catch (err) {
        log.warn({ err: (err as Error).message }, "skill-review: unexpected failure (ignored)");
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
              model: config.sessions.titleModel ?? agent.model,
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
        ...(notices.length ? { notices } : {}),
        ...(thinkingMessages.length ? { thinkingMessages } : {}),
        ...(debugLogPath && !isSubagent ? { debugLogPath } : {}),
      };
    }
    return {
      status: "complete",
      finalText: result.finalText,
      turns: result.turns,
      ...(outboundAttachments.length ? { attachments: outboundAttachments } : {}),
      ...(notices.length ? { notices } : {}),
      ...(thinkingMessages.length ? { thinkingMessages } : {}),
      ...(debugLogPath && !isSubagent ? { debugLogPath } : {}),
    };
  } finally {
    sessions.close();
    scheduleStore.close();
    attachmentIndex?.close();
    skillLearning?.close();
  }
}

// tool_use parts across a turn's new messages — the "was this turn substantial?" signal
// for the skill-review trigger. Exported for tests.
export function countToolUses(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.content) if (p.type === "tool_use") n++;
  }
  return n;
}

// Replace image base64 payloads with a short marker so the debug log's full-input capture stays
// readable and bounded (one image can be hundreds of KB of base64). Logging only — never replayed.
function elideImageData(messages: Message[]): Message[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.map((p) =>
      p.type === "image" && p.source.kind === "base64"
        ? {
            type: "image" as const,
            source: {
              kind: "base64" as const,
              mediaType: p.source.mediaType,
              data: `[${p.source.data.length} base64 chars elided]`,
            },
          }
        : p,
    ),
  }));
}

// Pull human-readable reasoning out of a turn's new messages, one notice per thinking block,
// for surfacing to the user. Redacted blocks (opaque data, no readable text) are skipped.
function collectThinkingMessages(messages: Message[]): string[] {
  const out: string[] = [];
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const p of m.content) {
      if (p.type !== "thinking" || p.redacted) continue;
      const text = p.thinking.trim();
      if (text) out.push(`💭 ${text}`);
    }
  }
  return out;
}

// Cut the loaded tail at the most recent compaction marker. Messages before the marker
// were summarised INTO the marker's text when a previous turn overflowed, so the model's
// view starts there — without the cut, every later turn would reload the full history and
// pay the overflow round-trip again. The marker rides as a user-role message; fold it into
// an adjacent user message so role alternation stays valid for providers that enforce it.
// Exported for tests.
export function applyCompactionCut(tail: PersistedMessage[]): PersistedMessage[] {
  let idx = -1;
  for (let i = tail.length - 1; i >= 0; i--) {
    if (tail[i]!.channel === COMPACTION_CHANNEL) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return tail;
  const cut = tail.slice(idx);
  if (cut.length >= 2 && cut[0]!.role === "user" && cut[1]!.role === "user") {
    const merged: PersistedMessage = { ...cut[1]!, content: [...cut[0]!.content, ...cut[1]!.content] };
    return [merged, ...cut.slice(2)];
  }
  return cut;
}

function persistCompactionMarker(sessions: SessionStore, sessionId: string, summary: string): void {
  sessions.appendMessage({
    sessionId,
    role: "user",
    channel: COMPACTION_CHANNEL,
    content: [
      {
        type: "text",
        text:
          `[Conversation compacted — messages before this point were summarised to fit ` +
          `the model's context window. Summary of the earlier conversation:]\n${summary}`,
      },
    ],
  });
}

// The /compact trigger: a just-ingested user message whose text is the bare slash-command
// (optionally with a focus hint, e.g. "/compact focus on the deploy plan"). Ingest passes
// slash-commands the agent doesn't define through verbatim, so the raw text arrives here;
// session-resume markers ride as separate text parts and don't match. Exported for tests.
export function detectCompactCommand(msg: PersistedMessage): { focus: string } | null {
  if (msg.role !== "user") return null;
  for (const p of msg.content) {
    if (p.type !== "text") continue;
    const slash = detectSlashCommand(p.text);
    if (slash && slash.name === "compact") return { focus: slash.rest.trim() };
  }
  return null;
}

// Execute the built-in /compact: summarise the conversation the model would currently see
// (the cut tail, minus the /compact trigger itself), persist the user-facing reply and a
// compaction marker, and hand the reply text back as the turn's result. Summarise failure
// degrades to an apologetic reply with nothing persisted but the reply. Exported for tests.
export async function runCompactCommand(args: {
  provider: LLMProvider;
  model: string;
  sessions: SessionStore;
  sessionId: string;
  historyLimit: number;
  focus: string;
}): Promise<string> {
  const { provider, model, sessions, sessionId, historyLimit, focus } = args;
  const tail = applyCompactionCut(sessions.tail(sessionId, historyLimit));
  const prior = await prepareMessagesForTurn(tail.slice(0, -1));
  let reply: string;
  let summary: string | null = null;
  if (prior.length < 2) {
    reply = "There's not much conversation to compact yet — carry on, I'll keep up.";
  } else {
    summary = await summarizeConversation(provider, model, prior, focus ? { focus } : {});
    reply = summary
      ? "🗜️ Compacted. I've summarised our conversation up to here and will work from that " +
        "summary from now on. The full history is still stored and visible — ask me to recap " +
        "anything that seems lost."
      : "I couldn't compact just now — the summarisation call failed. Try again in a moment.";
  }
  sessions.appendMessage({
    sessionId,
    role: "assistant",
    content: [{ type: "text", text: reply }],
  });
  if (summary) {
    persistCompactionMarker(sessions, sessionId, summary);
    log.info({ sessionId, focused: Boolean(focus) }, "manual /compact: marker persisted");
  }
  return reply;
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
