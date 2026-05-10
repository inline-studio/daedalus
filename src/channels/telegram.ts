import type { Channel, ChannelContext, OutgoingMessage, IncomingAttachment } from "./base.js";
import { log } from "../log.js";

// Telegram channel — long-polling inbound + Bot API outbound.
//
// Inbound: getUpdates with long-polling (timeout=30). Each update with `message.text`
// or attachments is normalized and published via ctx.publish(). Photos and voice are
// fetched via getFile and attached as IncomingAttachment with raw bytes.
//
// Outbound: sendMessage. Outgoing attachments not yet wired.
export class TelegramChannel implements Channel {
  readonly id = "telegram";
  readonly defaultAgent: string;
  private token: string;
  private offset = 0;
  private running = false;
  private apiBase: string;

  constructor(opts: { defaultAgent: string; token: string }) {
    this.defaultAgent = opts.defaultAgent;
    this.token = opts.token;
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
  }

  async start(ctx: ChannelContext): Promise<void> {
    if (!this.token) throw new Error("TelegramChannel: token required");

    // Drop any pending updates so we don't replay old messages on restart.
    try {
      const initial = await this.getUpdates(0, 0);
      if (initial.length) this.offset = initial[initial.length - 1]!.update_id + 1;
    } catch (err) {
      log.warn({ err }, "telegram initial getUpdates failed; continuing");
    }

    this.running = true;
    void this.pollLoop(ctx);
    log.info({ channel: this.id }, "telegram long-polling started");
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(externalUserId: string, msg: OutgoingMessage): Promise<void> {
    if (!msg.text) return;
    const res = await fetch(`${this.apiBase}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: externalUserId, text: msg.text }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.error({ status: res.status, body }, "telegram sendMessage failed");
    }
  }

  private async pollLoop(ctx: ChannelContext): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.getUpdates(this.offset, 30);
        for (const u of updates) {
          this.offset = u.update_id + 1;
          if (!u.message) continue;
          await this.handleMessage(ctx, u.message).catch((err) =>
            log.error({ err }, "telegram handleMessage failed"),
          );
        }
      } catch (err) {
        if (this.running) {
          log.warn({ err }, "telegram getUpdates errored; backing off 5s");
          await sleep(5000);
        }
      }
    }
  }

  private async handleMessage(ctx: ChannelContext, m: TelegramMessage): Promise<void> {
    const externalUserId = String(m.chat.id);
    const externalMessageId = String(m.message_id);
    const text = m.text ?? m.caption ?? "";
    const attachments: IncomingAttachment[] = [];

    if (m.photo && m.photo.length) {
      // Telegram returns multiple sizes; pick the largest.
      const best = m.photo[m.photo.length - 1]!;
      const data = await this.downloadFile(best.file_id);
      if (data)
        attachments.push({
          kind: "image",
          mediaType: "image/jpeg",
          data,
        });
    }
    if (m.voice) {
      const data = await this.downloadFile(m.voice.file_id);
      if (data)
        attachments.push({
          kind: "audio",
          mediaType: m.voice.mime_type ?? "audio/ogg",
          data,
        });
    }
    if (m.document) {
      const data = await this.downloadFile(m.document.file_id);
      if (data)
        attachments.push({
          kind: "file",
          mediaType: m.document.mime_type ?? "application/octet-stream",
          ...(m.document.file_name ? { filename: m.document.file_name } : {}),
          data,
        });
    }

    if (!text && attachments.length === 0) return;

    await ctx.publish({
      channel: this.id,
      externalUserId,
      externalMessageId,
      ...(text ? { text } : {}),
      ...(attachments.length ? { attachments } : {}),
      receivedAt: new Date().toISOString(),
    });
  }

  private async getUpdates(offset: number, timeoutSec: number): Promise<TelegramUpdate[]> {
    const url = `${this.apiBase}/getUpdates?offset=${offset}&timeout=${timeoutSec}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}`);
    const json = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
    if (!json.ok) throw new Error("getUpdates returned ok=false");
    return json.result ?? [];
  }

  private async downloadFile(fileId: string): Promise<Buffer | null> {
    try {
      const fileRes = await fetch(`${this.apiBase}/getFile?file_id=${fileId}`);
      if (!fileRes.ok) return null;
      const json = (await fileRes.json()) as { ok: boolean; result?: { file_path?: string } };
      if (!json.ok || !json.result?.file_path) return null;
      const dl = await fetch(`https://api.telegram.org/file/bot${this.token}/${json.result.file_path}`);
      if (!dl.ok) return null;
      return Buffer.from(await dl.arrayBuffer());
    } catch (err) {
      log.warn({ fileId, err }, "telegram downloadFile failed");
      return null;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
  text?: string;
  caption?: string;
  photo?: Array<{ file_id: string; width: number; height: number }>;
  voice?: { file_id: string; mime_type?: string };
  document?: { file_id: string; file_name?: string; mime_type?: string };
}
