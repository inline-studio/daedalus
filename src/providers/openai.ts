import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResult,
  ContentPart,
  ImagePart,
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
    streaming: false, // BUG-05: complete() is a single blocking call — no streaming path exists
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
      // Reasoning models surface their chain-of-thought two ways depending on backend:
      //   - vLLM / DeepSeek expose a separate `reasoning_content` (or `reasoning`) field.
      //   - Others inline it as <think>…</think> at the start of `content`.
      // Capture whichever is present as a thinking part (ordered before the visible text) and
      // strip inline tags from what the user sees.
      const reasoningField =
        (msg as { reasoning_content?: string }).reasoning_content ??
        (msg as { reasoning?: string }).reasoning ??
        "";
      let visible = msg.content ?? "";
      let inlineThinking = "";
      if (visible.includes("<think>")) {
        const split = splitThinkTags(visible);
        inlineThinking = split.thinking;
        visible = split.rest;
      }
      const thinking = (reasoningField || inlineThinking).trim();
      if (thinking) content.push({ type: "thinking", thinking });
      if (visible) content.push({ type: "text", text: visible });
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

export function toOpenAIMessages(m: Message): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  const text = m.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("");
  const toolUses = m.content.filter((c) => c.type === "tool_use");
  const toolResults = m.content.filter((c) => c.type === "tool_result");
  const images = m.content.filter((c): c is ImagePart => c.type === "image");

  if (m.role === "user") {
    if (images.length) {
      // Multimodal user turn: send a content array of text + image_url parts. The caller
      // (kernel) only leaves images here when the agent has vision; otherwise they're
      // stripped before we get them, so a text-only model never receives an image_url.
      const parts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
      if (text) parts.push({ type: "text", text });
      for (const img of images) {
        const url =
          img.source.kind === "base64"
            ? `data:${img.source.mediaType};base64,${img.source.data}`
            : img.source.url;
        parts.push({ type: "image_url", image_url: { url } });
      }
      out.push({ role: "user", content: parts });
    } else if (text) {
      out.push({ role: "user", content: text });
    }
    for (const tr of toolResults) {
      const r = tr as { toolUseId: string; content: string };
      out.push({ role: "tool", tool_call_id: r.toolUseId, content: r.content });
    }
  } else if (m.role === "assistant") {
    const hasTools = toolUses.length > 0;
    out.push({
      role: "assistant",
      // OpenAI/litellm reject an assistant message with neither content nor tool_calls.
      // With tool_calls present, content may be null; without, it MUST be a string — so
      // fall back to "" (never null) for a content-less, tool-less assistant turn.
      content: hasTools ? text || null : text,
      ...(hasTools
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

// Pull <think>…</think> reasoning out of inline content. Handles multiple blocks and an
// unclosed trailing <think> (a truncated reasoning stream), returning the reasoning text and
// the visible remainder separately.
export function splitThinkTags(s: string): { thinking: string; rest: string } {
  let thinking = "";
  let rest = s.replace(/<think>([\s\S]*?)<\/think>/g, (_m, inner: string) => {
    thinking += inner;
    return "";
  });
  const open = rest.indexOf("<think>");
  if (open !== -1) {
    thinking += rest.slice(open + "<think>".length);
    rest = rest.slice(0, open);
  }
  return { thinking: thinking.trim(), rest: rest.trim() };
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
