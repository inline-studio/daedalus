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
  // Web-only: which conversation (session id) this message belongs to. The web UI lets a user
  // keep several separate conversations with the same agent, each its own isolated context.
  // When set, the message is appended to that session instead of the default/"Main" one (after
  // the channel verifies the session belongs to the resolved user). Other channels leave this
  // unset and always use the default session.
  conversationId?: string;
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

// A file to send alongside an outbound reply (e.g. a screenshot the agent took).
// Carries resolved bytes — the supervisor reads these from the AttachmentStore before
// calling send(), so channels just upload them.
export interface OutgoingAttachment {
  data: Buffer;
  mediaType: string;
  filename?: string;
  caption?: string;
}

export interface OutgoingMessage {
  text?: string;
  parts?: ContentPart[];
  attachments?: OutgoingAttachment[];
  // Web-only: which conversation (session id) this reply belongs to, so the web channel
  // delivers it to the right open conversation/tab rather than broadcasting to all of the
  // user's connections. Other channels ignore it.
  conversationId?: string;
}

export interface ChannelContext {
  publish(msg: IncomingMessage): Promise<void>;
}

export interface Channel {
  readonly id: string;
  readonly defaultAgent: string;
  start(ctx: ChannelContext): Promise<void>;
  stop(): Promise<void>;
  // Send an outbound message to a specific external user. The runner has already resolved
  // which channel to use; the platform-side address is the `externalUserId` argument.
  send(externalUserId: string, msg: OutgoingMessage): Promise<void>;
}
