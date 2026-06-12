import type { Channel, ChannelContext, OutgoingMessage } from "./base.js";
import { log } from "../log.js";

// WhatsApp channel — STUB.
//
// Two viable paths:
//   1. Meta Cloud API — webhook-driven, JSON over HTTPS, requires phone-number-id + access token.
//   2. whatsapp-web.js — unofficial, scans QR, browser-based.
//
// The Cloud API is the supportable choice; this stub declares the surface.
// Implement by accepting a webhook on a route registered with the WebChannel server,
// or by running a separate HTTP listener.
export class WhatsappChannel implements Channel {
  readonly id = "whatsapp";
  readonly defaultAgent: string;
  private accessToken: string;
  private phoneNumberId: string;

  constructor(opts: { defaultAgent: string; accessToken: string; phoneNumberId: string }) {
    this.defaultAgent = opts.defaultAgent;
    this.accessToken = opts.accessToken;
    this.phoneNumberId = opts.phoneNumberId;
  }

  async start(_ctx: ChannelContext): Promise<void> {
    if (!this.accessToken || !this.phoneNumberId) {
      throw new Error("WhatsappChannel: accessToken and phoneNumberId required");
    }
    log.warn(
      { channel: this.id },
      "WhatsApp channel is a stub — wire a webhook (Meta Cloud API) and parse messages.entry[].changes[].value.messages",
    );
  }

  async stop(): Promise<void> {
    /* noop */
  }

  async send(externalUserId: string, msg: OutgoingMessage): Promise<void> {
    if (!msg.text) return;
    const url = `https://graph.facebook.com/v20.0/${this.phoneNumberId}/messages`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: externalUserId,
          text: { body: msg.text },
        }),
      });
    } catch (err) {
      log.error({ err }, "whatsapp send failed (network error)");
      return;
    }
    // BUG-14: a 4xx/5xx (bad/expired token, rate-limit) was silently swallowed before; surface
    // it with the status + body so a failed send is diagnosable.
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error({ status: res.status, body }, "whatsapp send failed");
    }
  }
}
