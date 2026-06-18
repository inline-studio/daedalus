import type { CompletionRequest, CompletionResult, ProviderStreamEvent } from "../types.js";

export interface ProviderCapabilities {
  tools: boolean;
  streaming: boolean;
  vision: boolean;
  systemPromptAsField: boolean;
}

export interface LLMProvider {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;
  complete(req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResult>;
  // Optional streaming variant. Present (and capabilities.streaming true) only when the provider
  // supports it. Yields incremental deltas followed by a terminal `result` event. Callers that
  // only need the final value can use foldStream(); live consumers read the deltas as they arrive.
  stream?(req: CompletionRequest, signal?: AbortSignal): AsyncIterable<ProviderStreamEvent>;
}

// Drain a provider stream and return just the assembled result — the bridge between the streaming
// API and any caller that wants the buffered shape. Throws if the stream ends without a terminal
// `result` event (a malformed/aborted stream), so a silent partial never masquerades as complete.
export async function foldStream(
  events: AsyncIterable<ProviderStreamEvent>,
): Promise<CompletionResult> {
  let result: CompletionResult | undefined;
  for await (const ev of events) {
    if (ev.type === "result") result = ev.result;
  }
  if (!result) throw new Error("provider stream ended without a terminal result event");
  return result;
}

export class ProviderError extends Error {
  override readonly cause?: unknown;
  constructor(
    message: string,
    readonly providerId: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = "ProviderError";
    if (cause !== undefined) this.cause = cause;
  }
}
