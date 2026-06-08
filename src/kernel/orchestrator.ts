import type { ToolImpl, ToolContext } from "../tools/base.js";
import type { ArtemisConfig, AgentManifest } from "../config/schema.js";
import { loadAgent, listAgents } from "../brain/agents.js";
import type { SessionStore } from "../sessions/store.js";
import type { AgentDispatcher } from "../dispatch/base.js";
import { findPendingAskUser, buildResumeMessage } from "./agent-turn.js";

export interface OrchestratorContext {
  config: ArtemisConfig;
  parent: AgentManifest;
  sessions: SessionStore;
  userId: string;
  // The dispatcher to use for subagent turns. In host mode this is the in-process
  // dispatcher (synchronous kernel call). In docker mode this is the container
  // dispatcher (docker run a fresh subagent container, recursively).
  dispatcher: AgentDispatcher;
}

// `spawn_subagent` — the orchestrator's only handle to specialists. The subagent's
// session state lives in SessionStore keyed by (userId, subagentName) so:
//   - multiple spawn calls within one orchestrator turn resume the same conversation
//   - subagents remember everything they've done and asked
//   - if the subagent calls `ask_user`, we surface a pending-question marker that the
//     orchestrator is system-prompted to relay; the user's reply on the next orchestrator
//     turn becomes the next prompt for spawn_subagent, which the subagent receives as
//     the answer to its open question.
export async function buildSpawnSubagentTool(ctx: OrchestratorContext): Promise<ToolImpl | null> {
  if (ctx.parent.subagents.length === 0) return null;
  // `subagents: ['*']` expands to every agent in the brain (minus self —
  // an agent that can spawn itself is almost certainly a config mistake).
  // `[]` (omitted) means no spawn_subagent tool at all; the early return
  // above handles that.
  const allowed = ctx.parent.subagents.includes("*")
    ? (await listAgents(ctx.config.brain.path)).filter((n) => n !== ctx.parent.name)
    : ctx.parent.subagents;
  if (allowed.length === 0) return null;

  return {
    definition: {
      name: "spawn_subagent",
      description:
        `Delegate to a specialist AI agent. The user does NOT see this — present the result ` +
        `as your own.\n\n` +
        `Available: ${allowed.join(", ")}. ONLY names in that enum are subagents; anything ` +
        `else (e.g. the names listed under "Skills" in your system prompt — agent-browser, ` +
        `tpp, digitalocean-api, …) is a SKILL, not a subagent. Skills are CLIs / instruction ` +
        `sets you drive yourself via load_skill + bash; passing one here is rejected.\n\n` +
        `Subagents have persistent memory across calls within this conversation: a follow-up ` +
        `spawn to the same agent picks up where you left off.\n\n` +
        `RESPONSE SHAPES:\n` +
        `  - "RESULT: <text>"  — the subagent finished. Phrase the text in your own voice.\n` +
        `  - "PENDING_QUESTION: <text>"  — the subagent needs information from the user. ` +
        `Phrase the question in your own voice (don't reveal that a subagent asked it). ` +
        `When the user replies, call spawn_subagent again with the SAME agent and the user's ` +
        `answer as the prompt — that resumes the subagent.`,
      inputSchema: {
        type: "object",
        properties: {
          agent: { type: "string", enum: allowed },
          prompt: {
            type: "string",
            description:
              "Either: a fresh task description, or — if a previous spawn_subagent call to " +
              "this agent returned PENDING_QUESTION — the user's answer to that question.",
          },
        },
        required: ["agent", "prompt"],
        additionalProperties: false,
      },
    },
    async invoke(input, toolCtx: ToolContext) {
      const name = String(input.agent ?? "");
      const prompt = String(input.prompt ?? "");
      if (!allowed.includes(name)) {
        return { content: `subagent '${name}' is not in this agent's allowlist`, isError: true };
      }
      const sub = await loadAgent(ctx.config.brain.path, name);

      // The subagent owns its own per-user session (keyed by userId + subagent name).
      // Append the inbound turn before dispatching so the agent reads it from history.
      const subSession = ctx.sessions.getOrCreateSession(ctx.userId, sub.manifest.name);
      const tail = ctx.sessions.tail(subSession.id, 200);
      const pendingAsk = findPendingAskUser(
        tail
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content })),
      );

      if (pendingAsk) {
        // Resuming an open ask_user: append a tool_result with the answer.
        const resume = buildResumeMessage(pendingAsk.toolUseId, prompt);
        ctx.sessions.appendMessage({
          sessionId: subSession.id,
          role: resume.role,
          content: resume.content,
        });
      } else {
        // Fresh turn: append the orchestrator's prompt as the user message.
        ctx.sessions.appendMessage({
          sessionId: subSession.id,
          role: "user",
          content: [{ type: "text", text: prompt }],
        });
      }

      const result = await ctx.dispatcher.dispatch({
        agentName: sub.manifest.name,
        sessionId: subSession.id,
        userId: ctx.userId,
        isSubagent: true,
        // Propagate the parent turn's origin so a subagent that arms
        // schedule_message still routes deliveries back to the real user.
        ...(toolCtx.originChannel ? { originChannel: toolCtx.originChannel } : {}),
        ...(toolCtx.originExternalUserId
          ? { originExternalUserId: toolCtx.originExternalUserId }
          : {}),
      });

      if (result.status === "pending_question") {
        return {
          content: `PENDING_QUESTION: ${result.question}`,
        };
      }
      return { content: `RESULT: ${result.finalText}` };
    },
  };
}
