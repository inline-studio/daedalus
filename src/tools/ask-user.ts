import type { ToolImpl } from "./base.js";

// Special signal: when a subagent's tool call requests user input, we throw this from the
// tool handler. The kernel catches it, persists state with the unfilled tool_use, and
// returns a "pending question" result up the call chain to spawn_subagent. The orchestrator
// then surfaces the question in its own voice, gets the user's reply, and feeds it back
// when the subagent is invoked again.
export class AskUserSignal extends Error {
  constructor(
    readonly question: string,
    readonly toolUseId: string,
  ) {
    super(`subagent requested user input: ${question.slice(0, 80)}`);
    this.name = "AskUserSignal";
  }
}

// Built-in `ask_user` tool. Available only to subagents (the orchestrator and other
// top-level agents have a real channel to the user; they don't need this).
export const askUserTool: ToolImpl = {
  definition: {
    name: "ask_user",
    description:
      "Ask the user a question and pause. Their answer arrives in your next prompt. " +
      "Use ONE clear, focused question. The user-facing assistant will phrase it for you, " +
      "so don't address the user directly — just state what you need to know.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "What you need from the user. Phrase it as a fact-finding question; " +
            "the user-facing assistant will deliver it.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
  },
  async invoke(input) {
    const question = String(input.question ?? "").trim();
    if (!question) return { content: "Error: empty question", isError: true };
    // The kernel inspects this magic content shape; we attach the toolUseId via the
    // throw mechanism in the kernel's executeTool path, where we have access to it.
    throw new AskUserSignal(question, "");
  },
};
