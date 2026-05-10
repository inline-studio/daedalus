import type { ContentPart } from "../types.js";

// A channel is any inbound/outbound surface (CLI, web, telegram, whatsapp, …).
// IMPORTANT: there is no concept of "groups" here. All channels publish into the same
// session pool keyed by user; an agent sees the same conversation history regardless
// of which channel a message arrived on. Outbound replies are routed back to the
// channel where the most recent inbound came from (or to the channel attached to the
// triggering message, if the agent reply is a direct response).

export interface IncomingMessage {
  channel: string; // channel id, e.g. "telegram", "web", "cli"
  externalUserId: string; // platform-side user id; mapped to a unified user_id via SessionStore
  externalMessageId?: string;
  // Routing override: if set, the named agent handles this message instead of the channel default.
  addressedTo?: string;
  text?: string;
  attachments?: IncomingAttachment[];
  receivedAt: string; // ISO
}

export interface IncomingAttachment {
  kind: "image" | "audio" | "video" | "file";
  mediaType: string;
  filename?: string;
  // Either inline bytes or a URL we should fetch.
  data?: Buffer;
  url?: string;
}

export interface OutgoingMessage {
  text?: string;
  parts?: ContentPart[];
  // If unset, the channel will route to the user's last inbound channel.
  toExternalUserId?: string;
}

export interface ChannelContext {
  publish(msg: IncomingMessage): Promise<void>;
}

export interface Channel {
  readonly id: string;
  readonly defaultAgent: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  // Send an outbound message to a specific external user. Implementations look up the
  // platform-side address from `toExternalUserId`; the runner has already resolved which
  // channel to use.
  send(externalUserId: string, msg: OutgoingMessage): Promise<void>;
}
