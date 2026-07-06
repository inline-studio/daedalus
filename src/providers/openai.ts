import OpenAI from "openai";
import type {
  CompletionRequest,
  CompletionResult,
  ContentPart,
  ImagePart,
  Message,
  ProviderStreamEvent,
} from "../types.js";
import { ProviderError, type LLMProvider, type ProviderCapabilities } from "./base.js";
import { createThinkStreamSplitter } from "./stream-util.js";

export interface OpenAIAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  // Used so the same adapter can talk to ollama, vLLM, llama.cpp, lm-studio, etc.
  flavor?: "openai" | "ollama" | "vllm" | "llama-cpp" | "lm-studio";
  // Abort a stream after this many ms of NO tokens (a genuinely stalled upstream). The timer
  // resets on every chunk, so a slow-but-progressing generation is never cut off — only true
  // silence trips it. 0 (default) disables it, leaving the SDK's wall-clock timeout in charge.
  idleTimeoutMs?: number;
}

// Covers any OpenAI-compatible endpoint (vLLM, ollama /v1, llama.cpp --api, lm-studio, openrouter…).
// Tool-call schema is mapped to/from the normalized shape.
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities = {
    tools: true,
    streaming: true, // stream() implemented; complete() remains a separate blocking path
    vision: false, // depends on backend; mark per model later
    systemPromptAsField: false, // OpenAI uses a system message
  };
  private client: OpenAI;
  private idleTimeoutMs: number;

  constructor(opts: OpenAIAdapterOptions = {}) {
    this.id = `openai:${opts.flavor ?? "openai"}`;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 0;
    this.client = new OpenAI({
      apiKey: opts.apiKey ?? process.env.OPENAI_API_KEY ?? "no-key",
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  // Shared request body for complete() and stream() so the two paths can't drift on model,
  // message mapping, tools, or sampling params.
  private buildBody(
    req: CompletionRequest,
  ): OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming {
    return {
      model: req.model,
      messages: [
        { role: "system", content: req.system },
        ...req.messages.flatMap(toOpenAIMessages),
      ],
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
    };
  }

  async complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult> {
    try {
      const res = await this.client.chat.completions.create(this.buildBody(req), { signal });

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

  // Streaming variant. Emits text/thinking/tool-arg deltas as they arrive, accumulating the same
  // content it would otherwise build in one shot, then yields a terminal `result` with the
  // assembled CompletionResult. Reasoning is captured from either a `reasoning_content`/`reasoning`
  // delta field or inline <think> tags (via the chunk-aware splitter).
  async *stream(
    req: CompletionRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<ProviderStreamEvent> {
    // Stream-inactivity guard: abort only when NO tokens arrive for idleTimeoutMs (a genuine
    // upstream stall), never on mere slowness. armIdle() is called once before the request (to
    // cover time-to-first-token / prefill) and again on every chunk received, so a slow-but-
    // progressing generation resets the timer indefinitely and is waited out.
    const idleMs = this.idleTimeoutMs;
    const idleController = idleMs > 0 ? new AbortController() : undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const armIdle = (): void => {
      if (!idleController) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idleController.abort(new Error(`stream idle ${idleMs}ms`)), idleMs);
    };
    const effectiveSignal = idleController
      ? AbortSignal.any([idleController.signal, ...(signal ? [signal] : [])])
      : signal;
    try {
      armIdle();
      const s = await this.client.chat.completions.create(
        { ...this.buildBody(req), stream: true, stream_options: { include_usage: true } },
        { signal: effectiveSignal },
      );

      const splitter = createThinkStreamSplitter();
      let visible = "";
      let thinking = "";
      let usedReasoningField = false;
      // tool calls accumulate per delta index (id/name arrive once, arguments stream in pieces).
      const tools = new Map<
        number,
        { id: string; name: string; args: string; started: boolean }
      >();
      let finishReason: string | null = null;
      let usage: { prompt_tokens: number; completion_tokens: number } | undefined;

      for await (const chunk of s) {
        armIdle(); // a token arrived — reset the inactivity timer
        if (chunk.usage) {
          usage = {
            prompt_tokens: chunk.usage.prompt_tokens,
            completion_tokens: chunk.usage.completion_tokens,
          };
        }
        const choice = chunk.choices[0];
        if (!choice) continue;
        if (choice.finish_reason) finishReason = choice.finish_reason;
        const d = choice.delta as {
          content?: string | null;
          reasoning_content?: string;
          reasoning?: string;
          tool_calls?: Array<{
            index?: number;
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };

        const rc = d.reasoning_content ?? d.reasoning;
        if (rc) {
          usedReasoningField = true;
          thinking += rc;
          yield { type: "thinking_delta", text: rc };
        }

        if (typeof d.content === "string" && d.content) {
          if (usedReasoningField) {
            // Backend separates reasoning into its own field, so `content` is pure answer text.
            visible += d.content;
            yield { type: "text_delta", text: d.content };
          } else {
            // Reasoning (if any) is inline as <think>…</think> — split it live.
            const { textDelta, thinkingDelta } = splitter.push(d.content);
            if (thinkingDelta) {
              thinking += thinkingDelta;
              yield { type: "thinking_delta", text: thinkingDelta };
            }
            if (textDelta) {
              visible += textDelta;
              yield { type: "text_delta", text: textDelta };
            }
          }
        }

        for (const tc of d.tool_calls ?? []) {
          const idx = tc.index ?? 0;
          let slot = tools.get(idx);
          if (!slot) {
            slot = { id: tc.id ?? "", name: tc.function?.name ?? "", args: "", started: false };
            tools.set(idx, slot);
          }
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name = tc.function.name;
          if (!slot.started && slot.id && slot.name) {
            slot.started = true;
            yield { type: "tool_use_start", id: slot.id, name: slot.name };
          }
          if (tc.function?.arguments) {
            slot.args += tc.function.arguments;
            if (slot.id) yield { type: "tool_use_input_delta", id: slot.id, jsonDelta: tc.function.arguments };
          }
        }
      }

      // If the idle guard fired, surface it as a timeout — even when the SDK ended the
      // iterator cleanly on abort (rather than throwing), which would otherwise leave us
      // returning a silently truncated result. Only our own idle abort counts here; a caller
      // cancellation (signal) is left to propagate as an AbortError.
      if (idleController?.signal.aborted && !signal?.aborted) {
        throw new Error(`stream idle ${idleMs}ms`);
      }

      // Flush any reasoning/text held in the inline-think splitter's tail buffer.
      if (!usedReasoningField) {
        const tail = splitter.end();
        if (tail.thinkingDelta) {
          thinking += tail.thinkingDelta;
          yield { type: "thinking_delta", text: tail.thinkingDelta };
        }
        if (tail.textDelta) {
          visible += tail.textDelta;
          yield { type: "text_delta", text: tail.textDelta };
        }
      }

      const content: ContentPart[] = [];
      const t = thinking.trim();
      if (t) content.push({ type: "thinking", thinking: t });
      if (visible) content.push({ type: "text", text: visible });
      for (const [, slot] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
        let input: Record<string, unknown> = {};
        try {
          input = slot.args ? JSON.parse(slot.args) : {};
        } catch {
          input = { _raw: slot.args };
        }
        content.push({ type: "tool_use", id: slot.id, name: slot.name, input });
      }

      const result: CompletionResult = {
        message: { role: "assistant", content },
        stopReason: mapFinishReason(finishReason),
        ...(usage
          ? { usage: { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens } }
          : {}),
      };
      yield { type: "result", result };
    } catch (err) {
      // An idle-timer abort (upstream stalled) is surfaced as a timeout so the kernel classifies
      // it correctly — but only when it wasn't the caller's own cancellation coming through.
      if (idleController?.signal.aborted && !signal?.aborted) {
        throw new ProviderError(
          `model stream timed out after ${idleMs}ms with no output — upstream stalled`,
          this.id,
          err,
        );
      }
      throw new ProviderError(
        `OpenAI-compatible stream failed: ${(err as Error).message}`,
        this.id,
        err,
      );
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
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
