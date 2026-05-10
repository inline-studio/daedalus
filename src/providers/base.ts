import type { CompletionRequest, CompletionResult } from "../types.js";

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
