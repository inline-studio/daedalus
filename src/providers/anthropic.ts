import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  CompletionResult,
  ContentPart,
  Message,
  ToolUsePart,
} from "../types.js";
import { ProviderError, type LLMProvider, type ProviderCapabilities } from "./base.js";
import { log } from "../log.js";

export interface AnthropicAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
}

export class AnthropicProvider implements LLMProvider {
  readonly id = "anthropic";
  readonly capabilities: ProviderCapabilities = {
    tools: true,
    streaming: false, // BUG-05: complete() is a single blocking call — no streaming path exists
    vision: true,
    systemPromptAsField: true,
  };

  private client: Anthropic;

  constructor(opts: AnthropicAdapterOptions = {}) {
    this.client = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "",
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    try {
      const maxTokens = req.maxTokens ?? 4096;
      // Extended thinking: budget must be ≥1024 and strictly < max_tokens. Clamp to the window;
      // if the agent's max_tokens leaves no room for the 1024 floor, skip thinking with a warning
      // rather than letting the API reject the whole request.
      let thinkingCfg: Anthropic.ThinkingConfigParam | undefined;
      if (req.thinking) {
        const budget = Math.min(req.thinking.budgetTokens, maxTokens - 1);
        if (budget >= 1024) {
          thinkingCfg = { type: "enabled", budget_tokens: budget };
        } else {
          log.warn(
            { budgetTokens: req.thinking.budgetTokens, maxTokens },
            "extended thinking requested but max_tokens leaves <1024 for the budget — disabling thinking this call",
          );
        }
      }
      const useThinking = thinkingCfg !== undefined;
      const res = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: maxTokens,
          // Thinking is incompatible with a non-default temperature — only send temperature when
          // thinking is OFF.
          ...(req.temperature !== undefined && !useThinking ? { temperature: req.temperature } : {}),
          ...(thinkingCfg ? { thinking: thinkingCfg } : {}),
          system: req.system,
          // When thinking is OFF, strip any thinking blocks carried in history — replaying them
          // to a non-thinking request is rejected. When ON, they're preserved (and MUST be,
          // mid-tool-loop) by toAnthropicMessage.
          messages: req.messages
            .filter((m) => m.role !== "system")
            .map((m) => toAnthropicMessage(m, useThinking)),
          ...(req.tools.length
            ? {
                tools: req.tools.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
                })),
              }
            : {}),
          ...(req.stopSequences ? { stop_sequences: req.stopSequences } : {}),
        },
        { signal },
      );

      const message: Message = {
        role: "assistant",
        content: res.content.map(fromAnthropicBlock),
      };

      return {
        message,
        stopReason: mapStopReason(res.stop_reason),
        ...(res.usage
          ? {
              usage: {
                inputTokens: res.usage.input_tokens,
                outputTokens: res.usage.output_tokens,
                // BUG-07: surface cache tokens so usage isn't understated on cached requests.
                ...(res.usage.cache_read_input_tokens != null
                  ? { cacheReadTokens: res.usage.cache_read_input_tokens }
                  : {}),
                ...(res.usage.cache_creation_input_tokens != null
                  ? { cacheCreationTokens: res.usage.cache_creation_input_tokens }
                  : {}),
              },
            }
          : {}),
      };
    } catch (err) {
      throw new ProviderError(
        `Anthropic completion failed: ${(err as Error).message}`,
        this.id,
        err,
      );
    }
  }
}

export function toAnthropicMessage(m: Message, keepThinking: boolean): Anthropic.MessageParam {
  // A thinking block can only be replayed when thinking is enabled AND it carries the data the
  // API can verify: a signature (normal block) or redacted opaque data. Drop the rest.
  const parts = m.content.filter((p) => {
    if (p.type !== "thinking") return true;
    if (!keepThinking) return false;
    return Boolean(p.signature) || p.redacted === true;
  });
  const role = m.role === "user" || m.role === "assistant" ? m.role : "user";
  return { role, content: parts.map(toAnthropicBlock) };
}

function toAnthropicBlock(p: ContentPart): Anthropic.ContentBlockParam {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
    case "thinking":
      return p.redacted
        ? { type: "redacted_thinking", data: p.thinking }
        : { type: "thinking", thinking: p.thinking, signature: p.signature ?? "" };
    case "tool_use":
      return { type: "tool_use", id: p.id, name: p.name, input: p.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: p.toolUseId,
        content: p.content,
        ...(p.isError ? { is_error: true } : {}),
      };
    case "image":
      if (p.source.kind === "base64") {
        return {
          type: "image",
          source: {
            type: "base64",
            media_type: p.source.mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
            data: p.source.data,
          },
        };
      }
      // URL-source images aren't supported by this SDK version; degrade to a text reference.
      return { type: "text", text: `[image: ${p.source.url}]` };
    case "audio":
      // Anthropic doesn't accept audio in MessageParam — surface the transcript if present.
      return {
        type: "text",
        text: p.transcript ? `[audio transcript] ${p.transcript}` : `[audio ${p.mediaType}]`,
      };
    case "file":
      return {
        type: "text",
        text: `[file ${p.filename} (${p.mediaType}) ref=${p.ref}]${p.excerpt ? `\n${p.excerpt}` : ""}`,
      };
  }
}

export function fromAnthropicBlock(b: Anthropic.ContentBlock): ContentPart {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "thinking":
      // Preserve the signature so the block can be replayed verbatim during a tool loop.
      return { type: "thinking", thinking: b.thinking, signature: b.signature };
    case "redacted_thinking":
      return { type: "thinking", thinking: b.data, redacted: true };
    case "tool_use":
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      } satisfies ToolUsePart;
    default:
      // server_tool_use, etc. — not surfaced; fold into empty text.
      return { type: "text", text: "" };
  }
}

function mapStopReason(r: Anthropic.Message["stop_reason"]): CompletionResult["stopReason"] {
  switch (r) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}
