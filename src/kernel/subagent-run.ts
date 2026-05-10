import path from "node:path";
import type { ArtemisConfig, AgentManifest } from "../config/schema.js";
import type { ContentPart, Message, ToolUsePart, ToolResultPart } from "../types.js";
import { Kernel } from "./agent.js";
import { buildProvider } from "../providers/index.js";
import { buildRuntime } from "../runtime/factory.js";
import { selectBuiltins } from "../tools/registry.js";
import { askUserTool } from "../tools/ask-user.js";
import { composeSystemPrompt } from "../brain/composer.js";
import { loadSkill } from "../brain/skills.js";
import type { ConnectedServer } from "../mcp/client.js";
import { resolveProviderKey } from "../providers/resolve.js";
import { buildSecretsBackend } from "../secrets/store/factory.js";
import { SessionStore, type PersistedMessage } from "../sessions/store.js";

// One subagent invocation. Backed by SessionStore — a (user_id, agent_name) keypair gives
// the subagent its own persistent memory across calls. Three flow shapes:
//
//   1. Fresh prompt:  history is empty OR last message isn't a pending ask_user. Append the
//      orchestrator's prompt as a user turn and run.
//   2. Resume from ask_user:  history's last assistant message contains an unfilled
//      tool_use(ask_user, …). Append a tool_result for that id with the orchestrator's
//      input as the answer, then run.
//   3. Halt mid-run:  during execution the subagent calls ask_user again. We persist the
//      assistant message with the new tool_use and bubble PENDING_QUESTION up.
//
// Returns a discriminated result the spawn_subagent tool formats for the orchestrator.

export interface SubagentRunInput {
  config: ArtemisConfig;
  agent: AgentManifest;
  agentBody: string;
  prompt: string;
  // Caller-provided user_id. The orchestrator passes its own session's user_id so the
  // subagent's memory is per-user.
  userId: string;
  sessions: SessionStore;
  // Reuse the parent's MCP connections rather than respawning per subagent.
  mcpServers: Map<string, ConnectedServer>;
}

export type SubagentResult =
  | { status: "complete"; finalText: string; turns: number }
  | { status: "pending_question"; question: string; turns: number };

export async function runSubagentTurn(input: SubagentRunInput): Promise<SubagentResult> {
  const { config, agent, agentBody, prompt, userId, sessions, mcpServers } = input;

  const session = sessions.getOrCreateSession(userId, agent.name);
  const tail = sessions.tail(session.id, 200);

  // Decide whether the orchestrator's prompt is a fresh user turn or the answer to a
  // previously-asked question.
  const initialMessages = await prepareMessages(tail, prompt);

  // Persist the new turn (either the user message or the tool_result) BEFORE running so
  // the state is recoverable if the kernel crashes.
  const newlyAdded = initialMessages.length - tailToMessages(tail).length;
  for (const m of initialMessages.slice(initialMessages.length - newlyAdded)) {
    sessions.appendMessage({ sessionId: session.id, role: m.role, content: m.content });
  }

  // Skills + system prompt
  const skills = (
    await Promise.all(
      agent.skills.map((s) => loadSkill(config.brain.path, s, config.brain.writable)),
    )
  ).filter((s): s is NonNullable<typeof s> => s !== null);

  const system = await composeSystemPrompt({
    brainPath: config.brain.path,
    agent,
    agentBody,
    skills,
    identity: config.identity.nickname
      ? { name: config.identity.name, nickname: config.identity.nickname }
      : { name: config.identity.name },
    isSubagent: true,
  });

  // Provider / runtime / tools (with ask_user added)
  const secretsBackend = await buildSecretsBackend(config, { envFileBaseDir: process.cwd() });
  await resolveProviderKey(agent, config, secretsBackend);
  const provider = buildProvider(agent, config);
  const runtime = buildRuntime(agent, config);

  const builtinTools = selectBuiltins(agent.tools, config);
  builtinTools.push(askUserTool);
  // (Subagents could spawn further subagents via spawn_subagent if their manifest
  // declares any. That's not wired here yet; one level of delegation is the v1 surface.)

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
    },
    maxTurns: agent.maxTurns,
    maxTokens: agent.maxTokens,
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
  });

  const result = await kernel.runWithMessages(initialMessages);

  // Persist whatever the kernel produced. For pending_question, the assistant message
  // ends with a tool_use(ask_user) and there is no tool_result — that's the contract,
  // we want exactly this shape on disk so resume can fill it in.
  // For complete, persist the final assistant message.
  // For mid-run tool calls, the kernel appends them internally; we persist only the
  // delta beyond the initialMessages we already saved.
  const newMessages = result.messages.slice(initialMessages.length);
  for (const m of newMessages) {
    sessions.appendMessage({ sessionId: session.id, role: m.role, content: m.content });
  }

  if (result.pendingQuestion) {
    return {
      status: "pending_question",
      question: result.pendingQuestion.question,
      turns: result.turns,
    };
  }
  return { status: "complete", finalText: result.finalText, turns: result.turns };
}

// Build the message array we feed the kernel: prior history + the new turn (user message
// or tool_result for an outstanding ask_user).
async function prepareMessages(tail: PersistedMessage[], prompt: string): Promise<Message[]> {
  const history = tailToMessages(tail);
  const pendingAsk = findPendingAskUser(history);

  if (pendingAsk) {
    // Append a tool_result that fills the open tool_use.
    const toolResult: ToolResultPart = {
      type: "tool_result",
      toolUseId: pendingAsk.toolUseId,
      content: prompt,
    };
    return [...history, { role: "user", content: [toolResult] }];
  }

  return [...history, { role: "user", content: [{ type: "text", text: prompt }] }];
}

function tailToMessages(tail: PersistedMessage[]): Message[] {
  return tail
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}

// If the most recent assistant message contains a tool_use(ask_user) that has not yet
// been answered with a matching tool_result in the next user turn, return its details.
function findPendingAskUser(messages: Message[]): { toolUseId: string } | null {
  if (messages.length === 0) return null;
  const last = messages[messages.length - 1]!;
  if (last.role !== "assistant") return null;
  const askUse = last.content.find(
    (c): c is ToolUsePart => c.type === "tool_use" && c.name === "ask_user",
  );
  return askUse ? { toolUseId: askUse.id } : null;
}
