import type { LLMProvider } from "../providers/base.js";
import type { ToolImpl, ToolContext } from "../tools/base.js";
import type { ConnectedServer } from "../mcp/client.js";
import { callMcpTool } from "../mcp/client.js";
import { AskUserSignal } from "../tools/ask-user.js";
import type {
  CompletionRequest,
  CompletionResult,
  ContentPart,
  ImagePart,
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
  // Image input policy (from the agent manifest's `vision`):
  //   undefined/false — no vision: images are stripped before the model call.
  //   true            — the agent's own `model` is multimodal: send images to it.
  //   "provider/model"— a SEPARATE vision model. Inbound images are described by it in a
  //                     minimal side-call (just the image + the user's text — no history,
  //                     no tools), and the description is injected as text so the main
  //                     `model` handles the turn with full context and tools. Keeps the
  //                     (often small-window) vision model's payload tiny.
  vision?: boolean | string;
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
  // User-facing notices produced during the turn (e.g. "compacted earlier history").
  // The dispatcher forwards these to the channel so the user knows what happened.
  notices?: string[];
}

// One agent loop: send -> read tool calls -> execute -> reply -> until end_turn or maxTurns.
export class Kernel {
  private builtinByName = new Map<string, ToolImpl>();
  private allToolDefs: ToolDefinition[];
  // User-facing notices accumulated during a run (reset per runWithMessages).
  private notices: string[] = [];

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
    this.notices = [];

    // If a separate vision model is configured, turn the freshest image into text up front
    // (a tiny side-call) so the rest of the turn runs entirely on the main model.
    await this.describeImages(messages, signal);

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
              ...(this.notices.length ? { notices: [...this.notices] } : {}),
            };
          }
          throw err;
        }
      }
      messages.push({ role: "user", content: toolResults });
    }

    return {
      messages,
      finalText,
      turns,
      stopReason,
      ...(this.notices.length ? { notices: [...this.notices] } : {}),
    };
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
    let triedCompact = false;
    for (;;) {
      // Apply the vision policy: pick the model (default vs a routed vision model) and the
      // image-bearing view to send (stripped when the target model can't see images).
      const { messages: sendView, model } = this.resolveVision(view);
      const req: CompletionRequest = {
        system: this.opts.system,
        messages: sendView,
        tools: this.allToolDefs,
        model,
        maxTokens: this.opts.maxTokens,
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      };
      try {
        return await this.completeWithRetry(req, signal);
      } catch (err) {
        if (!isContextOverflowError(err)) throw err;
        // First overflow: try to COMPACT — summarise the older portion into a synopsis and
        // keep recent turns verbatim. Lossy-but-informative, unlike dropping. Triggered by
        // the provider's *actual* "context exceeded" error, so it adapts to whatever window
        // the model has — no hardcoded cap. Once per call; if it still overflows afterwards
        // (or summarising fails), fall back to dropping oldest so we always make progress.
        if (!triedCompact) {
          triedCompact = true;
          const compacted = await this.tryCompact(view, signal);
          if (compacted) {
            this.notices.push(
              "🗜️ Our conversation got long, so I summarised the earlier part to stay within the model's context window. Ask me to recap anything I seem to have lost.",
            );
            log.info(
              { fromMessages: view.length, toMessages: compacted.length },
              "context window exceeded — compacted older history into a summary",
            );
            view = compacted;
            continue;
          }
        }
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

  // Decide which images (if any) the model sees this completion. A multimodal `model`
  // (vision:true) gets the freshest image directly; otherwise images are stripped — a
  // separate vision model has already converted them to text via describeImages(), and a
  // text-only model can't accept raw images. The model is always the agent's own `model`;
  // the separate vision model is only ever used inside describeImages().
  private resolveVision(view: Message[]): { messages: Message[]; model: string } {
    if (this.opts.vision === true) {
      return { messages: keepLatestImages(view), model: this.opts.model };
    }
    return { messages: stripImages(view), model: this.opts.model };
  }

  // Separate-vision-model path. Convert the most recently received image(s) into a text
  // description via a minimal side-call to the vision model (just the image + the user's
  // text — no history, no tools, tiny system), then splice that text into the message in
  // place of the image. Keeps the (often small-window) vision model's payload tiny, and
  // lets the main model handle the actual turn with full context + tools. Non-fatal: if
  // the call fails, drop the image and note it so the turn still completes.
  private async describeImages(messages: Message[], signal?: AbortSignal): Promise<void> {
    const v = this.opts.vision;
    if (typeof v !== "string" || v.length === 0) return;
    let idx = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (hasImage(messages[i]!)) {
        idx = i;
        break;
      }
    }
    if (idx === -1) return;
    const msg = messages[idx]!;
    const images = msg.content.filter((c): c is ImagePart => c.type === "image");
    if (images.length === 0) return;
    const userText = collectText(msg.content).trim();

    let description = "";
    try {
      const res = await this.completeWithRetry(
        {
          system:
            "You are a vision model. Describe the attached image(s) in thorough, concrete " +
            "detail. If the user's message asks something specific about the image, answer " +
            "that as part of the description. Output plain text only — no preamble.",
          messages: [
            {
              role: "user",
              content: [
                ...(userText ? [{ type: "text", text: userText } as ContentPart] : []),
                ...images,
              ],
            },
          ],
          tools: [],
          model: v,
          maxTokens: this.opts.maxTokens,
        },
        signal,
      );
      description = collectText(res.message.content).trim();
    } catch (err) {
      log.warn(
        { err: (err as Error).message, visionModel: v },
        "vision describe call failed — proceeding without the image",
      );
    }

    const rest = msg.content.filter((c) => c.type !== "image");
    if (description) {
      log.info({ visionModel: v, chars: description.length }, "described image via vision model");
      rest.push({ type: "text", text: `[Image description (via ${v}): ${description}]` });
    } else {
      this.notices.push(
        "⚠️ I couldn't view the image — the vision model is unavailable right now — so I'm replying without it.",
      );
      rest.push({ type: "text", text: "[An image was attached but the vision model couldn't be reached.]" });
    }
    messages[idx] = { role: msg.role, content: rest };
  }

  // Summarise the older portion of `view` into a single synopsis prepended to the most
  // recent kept turn, returning a shorter message list — or null when there's nothing
  // worth compacting (caller then falls back to dropping oldest). Lossy by design: a long
  // history becomes a dense summary, freeing context while preserving the gist. The full
  // history is untouched in the session DB; we only shrink what's SENT this turn.
  private async tryCompact(view: Message[], signal?: AbortSignal): Promise<Message[] | null> {
    if (view.length <= 3) return null;
    // Keep the most recent half (>=2) verbatim; summarise everything older.
    const keep = Math.max(2, Math.floor(view.length / 2));
    let recent = view.slice(view.length - keep);
    // The kept window must open cleanly (not on an assistant turn or a bare tool_result).
    while (recent.length > 1 && startsMidExchange(recent[0]!)) recent = recent.slice(1);
    const older = view.slice(0, view.length - recent.length);
    if (older.length === 0 || recent.length === 0) return null;
    const summary = await this.summarize(older, signal);
    if (!summary) return null;
    const preamble: ContentPart = {
      type: "text",
      text: `[Summary of earlier conversation, condensed to save context]\n${summary}`,
    };
    const head = recent[0]!;
    if (head.role === "user") {
      // Fold the summary into the first kept user message — keeps role alternation valid.
      const newHead: Message = { role: "user", content: [preamble, ...head.content] };
      return [newHead, ...recent.slice(1)];
    }
    // Rare: kept window opens on an assistant turn. Prepend a standalone user synopsis.
    return [{ role: "user", content: [preamble] }, ...recent];
  }

  // Ask the model to compress a slice of history into a dense, replaceable summary.
  // Returns null on any failure so the caller falls back to dropping (never blocks a turn).
  private async summarize(messages: Message[], signal?: AbortSignal): Promise<string | null> {
    const transcript = messages
      .map((m) => `${m.role.toUpperCase()}: ${summarizeContent(m.content)}`)
      .join("\n\n");
    const req: CompletionRequest = {
      system:
        "You compress conversation history. Produce a dense, factual summary that can REPLACE " +
        "the original messages in context. Capture: the user's goals and stated preferences, key " +
        "facts and decisions, specifics worth keeping (names, numbers, URLs, file paths), and any " +
        "open threads or pending actions. Use terse prose or bullets. No preamble, no commentary.",
      messages: [
        { role: "user", content: [{ type: "text", text: `Summarise this conversation:\n\n${transcript}` }] },
      ],
      tools: [],
      model: this.opts.model,
      maxTokens: 1024,
    };
    try {
      const res = await this.completeWithRetry(req, signal);
      const text = collectText(res.message.content).trim();
      return text.length ? text : null;
    } catch (err) {
      log.warn(
        { err: (err as Error).message },
        "compaction summary failed — falling back to dropping history",
      );
      return null;
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
//
// IMPORTANT: the OpenAI SDK + undici wrap the actual transport error 3+ levels deep:
//   ProviderError("Connection error.")
//     -> Error("Connection error.")
//        -> TypeError("fetch failed")
//           -> SocketError("other side closed" / "ECONNRESET" / …)
// The real signal lives at the bottom. Earlier versions of this function only
// looked at err + err.cause (depth 2), so connection-error failures were
// classified as non-transient and never retried — one network blip surfaced as
// a hard failure to the user (the bug that motivated walking the full chain).
export function isTransientLLMError(err: unknown): boolean {
  // Flatten the entire .cause chain so the matcher sees every layer's message,
  // name, and code — including the SocketError at the bottom.
  const chain = collectCauseChain(err);
  const status = chain
    .map((e) => (e as { status?: number }).status)
    .find((s): s is number => typeof s === "number");
  if (typeof status === "number") {
    return status === 408 || status === 425 || status === 429 || status >= 500;
  }
  const text = chain
    .map((e) => {
      const m = (e as Error).message ?? "";
      const n = (e as Error).name ?? "";
      const c = (e as { code?: string }).code ?? "";
      return `${n} ${m} ${c}`;
    })
    .join(" ")
    .toLowerCase();
  // Transport-error patterns: explicit timeout markers, the various "remote
  // side hung up" phrasings (Node's undici emits "other side closed" / "socket
  // hang up" / "premature close" depending on TLS state), plus the standard
  // POSIX error codes. Numeric `5xx` catches "HTTP 503" style mentions when
  // the status didn't get attached as a property.
  return /(429|overload|rate.?limit|timeout|timed out|temporarily|unavailable|fetch failed|socket(?:error)? (?:hang up|closed)|other side closed|premature close|connection (?:reset|closed|refused|aborted|error)|econnreset|etimedout|econnrefused|econnaborted|epipe|eai_again|und_err|\b5\d\d\b)/.test(
    text,
  );
}

// Walk an error and every nested `.cause`, returning them in order (outermost
// first). Caps at 8 to avoid pathological cycles.
function collectCauseChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur && typeof cur === "object" && !seen.has(cur) && out.length < 8) {
    seen.add(cur);
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
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

// Render a message's content parts to compact text for the summariser. Tool I/O is
// truncated so a chatty history doesn't blow the summary call itself.
function summarizeContent(parts: ContentPart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        out.push(p.text);
        break;
      case "tool_use":
        out.push(`[called ${p.name}(${truncateText(JSON.stringify(p.input), 300)})]`);
        break;
      case "tool_result":
        out.push(`[tool result: ${truncateText(p.content, 1500)}]`);
        break;
      case "image":
        out.push("[image]");
        break;
      case "audio":
        out.push(p.transcript ? `[audio: ${p.transcript}]` : "[audio]");
        break;
      case "file":
        out.push(`[file ${p.filename}]`);
        break;
    }
  }
  return out.join("\n");
}

function truncateText(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

const hasImage = (m: Message): boolean => m.content.some((c) => c.type === "image");

function stripImagesFromMessage(m: Message): Message {
  if (!hasImage(m)) return m;
  const content = m.content.filter((c) => c.type !== "image");
  // Keep the message non-empty so the provider doesn't choke on an empty turn.
  if (content.length === 0) content.push({ type: "text", text: "[image omitted]" });
  return { role: m.role, content };
}

// Remove every image part — used when the target model has no vision.
function stripImages(messages: Message[]): Message[] {
  if (!messages.some(hasImage)) return messages;
  return messages.map(stripImagesFromMessage);
}

// Keep images only in the most recent message that has any; strip them from older
// messages so the same picture isn't re-sent (re-charged) on every subsequent turn.
function keepLatestImages(messages: Message[]): Message[] {
  let lastIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (hasImage(messages[i]!)) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) return messages;
  return messages.map((m, i) => (i === lastIdx ? m : stripImagesFromMessage(m)));
}
