import Anthropic from "@anthropic-ai/sdk";
import type {
  CompletionRequest,
  CompletionResult,
  ContentPart,
  Message,
  ToolUsePart,
} from "../types.js";
import { ProviderError, type LLMProvider, type ProviderCapabilities } from "./base.js";

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
      const res = await this.client.messages.create(
        {
          model: req.model,
          max_tokens: req.maxTokens ?? 4096,
          ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          system: req.system,
          messages: req.messages.filter((m) => m.role !== "system").map(toAnthropicMessage),
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
          ? { usage: { inputTokens: res.usage.input_tokens, outputTokens: res.usage.output_tokens } }
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

function toAnthropicMessage(m: Message): Anthropic.MessageParam {
  if (m.role !== "user" && m.role !== "assistant") {
    // tool/system roles are folded; tool results live inside user messages here
    return { role: "user", content: m.content.map(toAnthropicBlock) };
  }
  return { role: m.role, content: m.content.map(toAnthropicBlock) };
}

function toAnthropicBlock(p: ContentPart): Anthropic.ContentBlockParam {
  switch (p.type) {
    case "text":
      return { type: "text", text: p.text };
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

function fromAnthropicBlock(b: Anthropic.ContentBlock): ContentPart {
  switch (b.type) {
    case "text":
      return { type: "text", text: b.text };
    case "tool_use":
      return {
        type: "tool_use",
        id: b.id,
        name: b.name,
        input: (b.input ?? {}) as Record<string, unknown>,
      } satisfies ToolUsePart;
    default:
      // thinking, server_tool_use, etc. — fold into text for now
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
