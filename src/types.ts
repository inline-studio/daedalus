// Provider-agnostic message and tool types. All adapters convert to/from these.

export type Role = "system" | "user" | "assistant" | "tool";

export interface TextPart {
  type: "text";
  text: string;
}

export interface ToolUsePart {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultPart {
  type: "tool_result";
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ImagePart {
  type: "image";
  source: { kind: "base64"; mediaType: string; data: string } | { kind: "url"; url: string };
}

export interface AudioPart {
  type: "audio";
  // Most providers don't accept raw audio in the chat turn; channels should transcribe
  // and inject a TextPart, but we keep this so a future provider can use it directly.
  mediaType: string;
  source: { kind: "base64"; data: string } | { kind: "url"; url: string };
  transcript?: string;
}

export interface FilePart {
  type: "file";
  filename: string;
  mediaType: string;
  // Reference to a stored attachment; the agent can read it via the `read_attachment` tool.
  ref: string;
  excerpt?: string;
}

export type ContentPart = TextPart | ToolUsePart | ToolResultPart | ImagePart | AudioPart | FilePart;

export interface Message {
  role: Role;
  content: ContentPart[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface CompletionRequest {
  system: string;
  messages: Message[];
  tools: ToolDefinition[];
  model: string;
  maxTokens?: number;
  temperature?: number;
  stopSequences?: string[];
}

export interface CompletionEvent {
  type: "text_delta" | "tool_use" | "stop" | "error";
  text?: string;
  toolUse?: ToolUsePart;
  stopReason?: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error";
  error?: string;
}

export interface CompletionResult {
  message: Message;
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop_sequence" | "error";
  usage?: {
    inputTokens: number;
    outputTokens: number;
    // BUG-07: cache tokens (Anthropic prompt caching) — present when the provider reports them.
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
}
