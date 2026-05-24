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
      const result = await this.completeFittingContext(messages, signal);
      if (result.usage) {
        // Per-turn token visibility. inputTokens is the whole replayed transcript
        // (system + history + this turn's tool I/O), so a climbing number here is the
        // signal that context — not turn count — is what's growing.
        log.info(
          {
            agent: this.opts.toolContext.agentName,
            model: this.opts.model,
            turn: turns,
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
          },
          "llm usage",
        );
      }
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
  // Wrap the LLM call with context-window management. If the provider rejects the
  // request for *length*, drop the OLDEST history and retry with a smaller window. The
  // dropped messages stay in the session DB — we only send the model less — so this
  // never breaks persistence or the returned message list (we trim a copy, not the
  // working set). When there's nothing left to trim and it STILL overflows, the agent's
  // base prompt (system instructions + tool schemas) alone exceeds the model's context;
  // surface that as an actionable error rather than looping.
  private async completeFittingContext(
    messages: Message[],
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    let view = messages;
    for (;;) {
      const req: CompletionRequest = {
        system: this.opts.system,
        messages: view,
        tools: this.allToolDefs,
        model: this.opts.model,
        maxTokens: this.opts.maxTokens,
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      };
      try {
        return await this.completeWithRetry(req, signal);
      } catch (err) {
        if (!isContextOverflowError(err)) throw err;
        const trimmed = trimOldest(view);
        if (trimmed.length >= view.length) {
          throw new Error(
            "Model context exceeded and history can't be trimmed further — the agent's base " +
              "prompt (system instructions + tool schemas) alone is too large for the model's " +
              "context window. Reduce the agent's skills / mcpServers / tools, or raise the " +
              `model's context cap. Underlying error: ${(err as Error).message}`,
          );
        }
        log.warn(
          { fromMessages: view.length, toMessages: trimmed.length, err: (err as Error).message },
          "context window exceeded — dropped oldest history and retrying",
        );
        view = trimmed;
      }
    }
  }

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

// The provider rejected the request because it's too long for the model's context.
// Matches the common phrasings across OpenAI / Anthropic / litellm / vLLM.
function isContextOverflowError(err: unknown): boolean {
  const msg = `${(err as Error)?.message ?? ""}`.toLowerCase();
  return /context (?:size|length|window)|context_length_exceeded|exceeds the available context|maximum context|too many tokens|prompt is too long|reduce the (?:length|prompt|number of (?:input )?tokens)/.test(
    msg,
  );
}

// Return a copy of `messages` with the oldest history dropped to make room. Keeps the
// most recent messages (including the latest user turn that triggered the run) and
// avoids leaving a dangling tool_result at the new head (providers reject a tool_result
// without its preceding tool_use). Returns the same array unchanged when nothing more
// can safely be dropped (only the trigger remains) — the caller treats that as "the base
// prompt itself is too big".
function trimOldest(messages: Message[]): Message[] {
  if (messages.length <= 1) return messages;
  const drop = Math.max(1, Math.floor(messages.length * 0.25));
  let out = messages.slice(drop);
  while (out.length > 1 && startsMidExchange(out[0]!)) out = out.slice(1);
  return out;
}

// A conversation window should open with a user message that isn't just a tool_result.
export function startsMidExchange(first: Message): boolean {
  if (first.role === "assistant") return true;
  return first.role === "user" && first.content.some((c) => c.type === "tool_result");
}

function collectText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}
