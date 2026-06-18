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

// A block of model reasoning. Produced by extended-thinking (Anthropic) or reasoning models
// (OpenAI-compatible). Surfaced to the user as "thinking" messages and recorded in the debug
// log. `signature` carries Anthropic's opaque verification token — it MUST be round-tripped
// verbatim when the block is replayed during a tool-use loop, or the API rejects the request.
// `redacted` marks an Anthropic `redacted_thinking` block whose `thinking` holds opaque data
// rather than human-readable text.
export interface ThinkingPart {
  type: "thinking";
  thinking: string;
  signature?: string;
  redacted?: boolean;
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

export type ContentPart =
  | TextPart
  | ThinkingPart
  | ToolUsePart
  | ToolResultPart
  | ImagePart
  | AudioPart
  | FilePart;

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
  // When set, request extended thinking (Anthropic). budgetTokens must be ≥1024 and <maxTokens;
  // the provider clamps and drops `temperature` (incompatible with thinking). Ignored by
  // providers that don't support a thinking-request param (OpenAI-compatible backends emit
  // reasoning on their own; it's captured regardless).
  thinking?: { budgetTokens: number };
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

// Incremental events emitted by a provider's optional `stream()` method. These are the
// PROVIDER-level events — display-facing token deltas plus a single terminal `result` carrying
// the fully assembled turn (identical to what `complete()` returns). A consumer can render the
// deltas live AND still get the canonical Message/usage/stopReason needed to drive the tool loop
// and persistence. Phase 1 wraps these into a richer kernel/channel-facing TurnEvent (turn
// boundaries, tool execution progress, notices); this union is deliberately just what a single
// provider completion produces.
export type ProviderStreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  // A tool call has begun; its id+name are known. Argument JSON arrives via input_delta events.
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; jsonDelta: string }
  // Terminal event: the complete, assembled result. Always the last event of a successful stream.
  | { type: "result"; result: CompletionResult };

// Kernel/channel-facing turn events. A superset of the provider deltas with the loop structure a
// UI needs to render a turn live: round boundaries, the assembled tool call, and tool-execution
// progress. The kernel forwards provider deltas as-is and adds the structural events. A sink that
// receives these can render token-by-token (text_delta/thinking_delta), show tool activity
// (tool_use → tool_running → tool_result), and know when the turn's reply is final (turn_complete).
export type TurnEvent =
  | { type: "turn_start"; turn: number }
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "tool_use_start"; id: string; name: string }
  | { type: "tool_use_input_delta"; id: string; jsonDelta: string }
  // The fully-assembled tool call (parsed input), emitted once the completion is complete.
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_running"; id: string; name: string }
  | { type: "tool_result"; id: string; name: string; isError: boolean }
  // A turn-loop ended with a final assistant reply (no further tool calls).
  | { type: "turn_complete"; finalText: string }
  // The conversation debug log for this turn (when enabled). Surfaced as activity chrome — like
  // tool/reasoning — rather than a separate chat message. Emitted by agent-turn after the run.
  | { type: "debug_log"; path: string };

export type TurnEventSink = (event: TurnEvent) => void;
