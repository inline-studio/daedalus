import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResult,
  ContentPart,
  Message,
} from "../types.js";
import { ProviderError, type LLMProvider, type ProviderCapabilities } from "./base.js";

export interface OpenAIAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  // Used so the same adapter can talk to ollama, vLLM, llama.cpp, lm-studio, etc.
  flavor?: "openai" | "ollama" | "vllm" | "llama-cpp" | "lm-studio";
}

// Covers any OpenAI-compatible endpoint (vLLM, ollama /v1, llama.cpp --api, lm-studio, openrouter…).
// Tool-call schema is mapped to/from the normalized shape.
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = {
    tools: true,
    streaming: true,
    vision: false, // depends on backend; mark per model later
    systemPromptAsField: false, // OpenAI uses a system message
  };
  private client: OpenAI;

  constructor(opts: OpenAIAdapterOptions = {}) {
    this.id = `openai:${opts.flavor ?? "openai"}`;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "no-key",
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    try {
      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: req.system },
        ...req.messages.flatMap(toOpenAIMessages),
      ];

      const res = await this.client.chat.completions.create(
        {
          model: req.model,
          messages,
          ...(req.maxTokens ? { max_tokens: req.maxTokens } : {}),
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          ...(req.stopSequences ? { stop: req.stopSequences } : {}),
          ...(req.tools.length
            ? {
                tools: req.tools.map((t) => ({
                  type: "function" as const,
                  function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.inputSchema as Record<string, unknown>,
                  },
                })),
              }
            : {}),
        },
        { signal },
      );

      const choice = res.choices[0];
      if (!choice) throw new Error("OpenAI returned no choices");
      const msg = choice.message;
      const content: ContentPart[] = [];
      if (msg.content) content.push({ type: "text", text: msg.content });
      for (const tc of msg.tool_calls ?? []) {
        if (tc.type !== "function") continue;
        let input: Record<string, unknown> = {};
        try {
          input = tc.function.arguments ? JSON.parse(tc.function.arguments) : {};
        } catch {
          input = { _raw: tc.function.arguments };
        }
        content.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
      }

      return {
        message: { role: "assistant", content },
        stopReason: mapFinishReason(choice.finish_reason),
        ...(res.usage
          ? {
              usage: {
                inputTokens: res.usage.prompt_tokens,
                outputTokens: res.usage.completion_tokens,
              },
            }
          : {}),
      };
    } catch (err) {
      throw new ProviderError(
        `OpenAI-compatible completion failed: ${(err as Error).message}`,
        this.id,
        err,
      );
    }
  }
}

function toOpenAIMessages(m: Message): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  const text = m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
  const toolUses = m.content.filter((c) => c.type === "tool_use");
  const toolResults = m.content.filter((c) => c.type === "tool_result");

  if (m.role === "user") {
    if (text) out.push({ role: "user", content: text });
    for (const tr of toolResults) {
      const r = tr as { toolUseId: string; content: string };
      out.push({ role: "tool", tool_call_id: r.toolUseId, content: r.content });
    }
  } else if (m.role === "assistant") {
    out.push({
      role: "assistant",
      content: text || null,
      ...(toolUses.length
        ? {
            tool_calls: toolUses.map((tu) => {
              const t = tu as { id: string; name: string; input: Record<string, unknown> };
              return {
                id: t.id,
                type: "function" as const,
                function: { name: t.name, arguments: JSON.stringify(t.input) },
              };
            }),
          }
        : {}),
    });
  }
  return out;
}

function mapFinishReason(r: string | null): CompletionResult["stopReason"] {
  switch (r) {
    case "stop":
      return "end_turn";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "length":
      return "max_tokens";
    default:
      return "end_turn";
  }
}
