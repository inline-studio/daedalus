import type { ToolImpl, ToolContext } from "../tools/base.js";
import type { ArtemisConfig, AgentManifest } from "../config/schema.js";
import { loadAgent } from "../brain/agents.js";
import type { ConnectedServer } from "../mcp/client.js";
import { runSubagentTurn } from "./subagent-run.js";
import type { SessionStore } from "../sessions/store.js";

export interface OrchestratorContext {
  config: ArtemisConfig;
  parent: AgentManifest;
  // Reuse the parent's MCP server connections rather than respawning per subagent.
  mcpServers: Map<string, ConnectedServer>;
  // Session store + the resolved user_id for the human at the channel. Subagents key
  // their own per-user memory off this so calls within the same conversation accrete.
  sessions: SessionStore;
  userId: string;
}

// `spawn_subagent` — the orchestrator's only handle to specialists. The subagent's
// session state lives in SessionStore keyed by (userId, subagentName) so:
//   - multiple spawn calls within one orchestrator turn resume the same conversation
//   - subagents remember everything they've done and asked
//   - if the subagent calls `ask_user`, we surface a pending-question marker that the
//     orchestrator is system-prompted to relay; the user's reply on the next orchestrator
//     turn becomes the next prompt for spawn_subagent, which the subagent receives as
//     the answer to its open question.
export function buildSpawnSubagentTool(ctx: OrchestratorContext): ToolImpl | null {
  if (ctx.parent.subagents.length === 0) return null;
  const allowed = ctx.parent.subagents;

  return {
    definition: {
      name: "spawn_subagent",
      description:
        `Delegate to a specialist agent. The user does NOT see this — present the result ` +
        `as your own.\n\n` +
        `Available: ${allowed.join(", ")}.\n\n` +
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
    async invoke(input, _toolCtx: ToolContext) {
      const name = String(input.agent ?? "");
      const prompt = String(input.prompt ?? "");
      if (!allowed.includes(name)) {
        return { content: `subagent '${name}' is not in this agent's allowlist`, isError: true };
      }
      const sub = await loadAgent(ctx.config.brain.path, name);
      const result = await runSubagentTurn({
        config: ctx.config,
        agent: sub.manifest,
        agentBody: sub.body,
        prompt,
        userId: ctx.userId,
        sessions: ctx.sessions,
        mcpServers: ctx.mcpServers,
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
