import { EventEmitter } from "node:events";
import type { Channel, IncomingMessage, OutgoingMessage } from "./base.js";
import type { SessionStore } from "../sessions/store.js";
import { log } from "../log.js";

// The bus owns the set of running channels and dispatches incoming messages to a single
// handler (the agent runner). Outgoing messages are routed by user_id back through the
// channel(s) that user has identities on.
export class MessageBus {
  private channels = new Map<string, Channel>();
  private emitter = new EventEmitter();

  constructor(private sessions: SessionStore) {}

  register(ch: Channel): void {
    if (this.channels.has(ch.id)) throw new Error(`channel already registered: ${ch.id}`);
    this.channels.set(ch.id, ch);
  }

  async startAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      await ch.start({ publish: (msg) => this.publish(msg) });
      log.info({ channel: ch.id }, "channel started");
    }
  }

  async stopAll(): Promise<void> {
    for (const ch of this.channels.values()) {
      await ch.stop().catch((err) => log.error({ channel: ch.id, err }, "channel stop failed"));
    }
  }

  channelFor(id: string): Channel | undefined {
    return this.channels.get(id);
  }

  // Subscribe a handler that receives every published message.
  onIncoming(handler: (msg: IncomingMessage) => Promise<void> | void): void {
    this.emitter.on("incoming", (msg: IncomingMessage) => {
      Promise.resolve(handler(msg)).catch((err) => log.error({ err }, "incoming handler failed"));
    });
  }

  private async publish(msg: IncomingMessage): Promise<void> {
    log.debug({ channel: msg.channel, user: msg.externalUserId }, "incoming");
    this.emitter.emit("incoming", msg);
  }

  // Send to whichever channel the user last appeared on, or to a specific channel if forced.
  async sendToUser(
    userId: string,
    msg: OutgoingMessage,
    options: { forceChannel?: string } = {},
  ): Promise<void> {
    let target: { channel: string; externalId: string } | null = null;
    if (options.forceChannel) {
      const identities = this.sessions.identitiesFor(userId);
      const match = identities.find((i) => i.channel === options.forceChannel);
      if (match) target = { channel: match.channel, externalId: match.externalId };
    } else {
      target = this.sessions.lastInboundChannel(userId);
    }
    if (!target) {
      log.warn({ userId }, "no channel identity for user — dropping outbound");
      return;
    }
    const ch = this.channels.get(target.channel);
    if (!ch) {
      log.warn({ channel: target.channel }, "channel not registered — dropping outbound");
      return;
    }
    await ch.send(target.externalId, msg);
  }
}
