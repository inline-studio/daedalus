import type { LLMProvider } from "../providers/base.js";
import type { ToolImpl, ToolContext } from "../tools/base.js";
import type { ConnectedServer } from "../mcp/client.js";
import { callMcpTool } from "../mcp/client.js";
import { AskUserSignal } from "../tools/ask-user.js";
import type {
  CompletionRequest,
  CompletionResult,
  ContentPart,
  Message,
  ToolDefinition,
  ToolUsePart,
  ToolResultPart,
} from "../types.js";
import { log } from "../log.js";

export interface KernelOptions {
  provider: LLMProvider;
  model: string;
  system: string;
  builtinTools: ToolImpl[];
  mcpServers: Map<string, ConnectedServer>;
  toolContext: ToolContext;
  maxTurns: number;
  maxTokens: number;
  temperature?: number;
}

export interface KernelResult {
  messages: Message[];
  finalText: string;
  turns: number;
  stopReason: string;
  // Set when execution halted because a subagent called `ask_user`. The orchestrator
  // surfaces the question to the user; on resume, the user's answer becomes the
  // tool_result for the recorded toolUseId.
  pendingQuestion?: { question: string; toolUseId: string };
}

// One agent loop: send -> read tool calls -> execute -> reply -> until end_turn or maxTurns.
export class Kernel {
  private builtinByName = new Map<string, ToolImpl>();
  private allToolDefs: ToolDefinition[];

  constructor(private opts: KernelOptions) {
    for (const t of opts.builtinTools) this.builtinByName.set(t.definition.name, t);

    const mcpDefs: ToolDefinition[] = [];
    for (const server of opts.mcpServers.values()) mcpDefs.push(...server.tools);

    this.allToolDefs = [...opts.builtinTools.map((t) => t.definition), ...mcpDefs];
  }

  async run(userPrompt: string, signal?: AbortSignal): Promise<KernelResult> {
    return this.runWithMessages(
      [{ role: "user", content: [{ type: "text", text: userPrompt }] }],
      signal,
    );
  }

  async runWithMessages(initialMessages: Message[], signal?: AbortSignal): Promise<KernelResult> {
    const messages: Message[] = [...initialMessages];

    let turns = 0;
    let stopReason = "end_turn";
    let finalText = "";

    while (turns < this.opts.maxTurns) {
      turns++;
      const req: CompletionRequest = {
        system: this.opts.system,
        messages,
        tools: this.allToolDefs,
        model: this.opts.model,
        maxTokens: this.opts.maxTokens,
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      };

      const result = await this.completeWithRetry(req, signal);
      messages.push(result.message);
      stopReason = result.stopReason;

      if (result.stopReason !== "tool_use") {
        finalText = collectText(result.message.content);
        break;
      }

      // Execute every tool_use and append tool_results in a single user message.
      const toolUses = result.message.content.filter((c): c is ToolUsePart => c.type === "tool_use");
      const toolResults: ToolResultPart[] = [];
      for (const tu of toolUses) {
        log.debug({ tool: tu.name, input: tu.input }, "tool call");
        try {
          const res = await this.executeTool(tu);
          toolResults.push({
            type: "tool_result",
            toolUseId: tu.id,
            content: res.content,
            ...(res.isError ? { isError: true } : {}),
          });
        } catch (err) {
          if (err instanceof AskUserSignal) {
            // Subagent wants to ask the user. Halt cleanly — leave the assistant
            // message with its open tool_use and DO NOT add a tool_result. The caller
            // (spawn_subagent) will persist this state; on resume, the user's reply
            // becomes the tool_result for this toolUseId.
            return {
              messages,
              finalText: "",
              turns,
              stopReason: "ask_user",
              pendingQuestion: { question: err.question, toolUseId: tu.id },
            };
          }
          throw err;
        }
      }
      messages.push({ role: "user", content: toolResults });
    }

    return { messages, finalText, turns, stopReason };
  }

  // The LLM call is the one step in the turn loop that fails *transiently* — rate
  // limits (429), provider overload (529), gateway/5xx, and network/proxy blips. Tool
  // and MCP errors are already caught and handed back to the model as tool_results; an
  // un-retried provider error here, by contrast, propagates out of the turn and crashes
  // the whole agent-turn (exit 1). Retry transient failures with exponential backoff +
  // jitter; fail fast on permanent ones (auth/bad-request) so real misconfig surfaces.
  private async completeWithRetry(
    req: CompletionRequest,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const maxAttempts = 4;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.opts.provider.complete(req, signal);
      } catch (err) {
        lastErr = err;
        if (attempt === maxAttempts || !isTransientLLMError(err)) throw err;
        const backoff = Math.min(8000, 500 * 2 ** (attempt - 1));
        const delayMs = backoff + Math.floor(Math.random() * 250);
        log.warn(
          { attempt, maxAttempts, delayMs, provider: this.opts.provider.id, err: (err as Error).message },
          "LLM call failed transiently — retrying",
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastErr;
  }

  private async executeTool(tu: ToolUsePart): Promise<{ content: string; isError?: boolean }> {
    // Built-in?
    const builtin = this.builtinByName.get(tu.name);
    if (builtin) {
      try {
        return await builtin.invoke(tu.input, this.opts.toolContext);
      } catch (err) {
        // Special signals propagate — they're a control-flow mechanism, not a tool error.
        if (err instanceof AskUserSignal) throw err;
        return { content: `Tool '${tu.name}' threw: ${(err as Error).message}`, isError: true };
      }
    }

    // MCP namespaced ("server__tool")?
    if (tu.name.includes("__")) {
      try {
        return await callMcpTool(this.opts.mcpServers, tu.name, tu.input);
      } catch (err) {
        return { content: `MCP call '${tu.name}' failed: ${(err as Error).message}`, isError: true };
      }
    }

    return { content: `Unknown tool: ${tu.name}`, isError: true };
  }
}

// Worth retrying: rate limits, overload, gateway/5xx, and network blips (incl. the
// OneCLI proxy hiccupping). NOT worth retrying: auth (401/403), bad request (400),
// not found (404) — those won't fix themselves, so we surface them immediately.
function isTransientLLMError(err: unknown): boolean {
  const cause = (err as { cause?: unknown }).cause;
  const status =
    (err as { status?: number }).status ?? (cause as { status?: number } | undefined)?.status;
  if (typeof status === "number") {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  // No HTTP status → a transport/network error (DNS, reset, timeout, proxy blip).
  const text = `${(err as Error).message ?? ""} ${(cause as Error | undefined)?.message ?? ""} ${
    (cause as { code?: string } | undefined)?.code ?? ""
  }`.toLowerCase();
  return /(429|overload|rate.?limit|timeout|timed out|temporarily|unavailable|fetch failed|socket hang up|econnreset|etimedout|econnrefused|eai_again|und_err|\b5\d\d\b)/.test(
    text,
  );
}

function collectText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}
