import type { Channel, ChannelContext, OutgoingMessage, IncomingAttachment } from "./base.js";
import { log } from "../log.js";
import { markdownToTelegramHtml, stripMarkdownForPlain } from "./format/telegram-html.js";

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
  // Sender allowlist (fail-closed): only these chat ids may drive the agent. Null when no
  // allowlist is configured, in which case ALL inbound is rejected — see handleMessage.
  private allowedChatIds: Set<string> | null;

  constructor(opts: { defaultAgent: string; token: string; allowedChatIds?: string[] }) {
    this.defaultAgent = opts.defaultAgent;
    this.token = opts.token;
    this.apiBase = `https://api.telegram.org/bot${this.token}`;
    this.allowedChatIds =
      opts.allowedChatIds && opts.allowedChatIds.length ? new Set(opts.allowedChatIds) : null;
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
    if (!this.allowedChatIds) {
      log.warn(
        { channel: this.id },
        "telegram: no allowedChatIds configured — ALL inbound messages will be rejected (fail-closed). " +
          "Add your chat id to channels.telegram.allowedChatIds (get it from @userinfobot).",
      );
    }
  }

  async stop(): Promise<void> {
    this.running = false;
  }

  async send(externalUserId: string, msg: OutgoingMessage): Promise<void> {
    // Text first (sendMessage handles long replies; captions are capped at 1024 chars,
    // so we don't fold the reply into an attachment caption).
    //
    // Rendering: Claude emits CommonMark (`**bold**`, `*italic*`, `` `code` `` …).
    // We translate it into Telegram's restricted HTML and ask the Bot API to
    // parse it as HTML. If Telegram rejects the message — typically a malformed
    // tag we couldn't catch — we retry once with markers stripped, so the user
    // at least sees the message instead of nothing.
    if (msg.text) {
      const html = markdownToTelegramHtml(msg.text);
      let res = await fetch(`${this.apiBase}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: externalUserId, text: html, parse_mode: "HTML" }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.warn(
          { status: res.status, body },
          "telegram sendMessage with HTML failed; retrying as plain text",
        );
        res = await fetch(`${this.apiBase}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: externalUserId, text: stripMarkdownForPlain(msg.text) }),
        });
        if (!res.ok) {
          const body2 = await res.text().catch(() => "");
          log.error({ status: res.status, body: body2 }, "telegram sendMessage failed");
        }
      }
    }

    // Then each attachment: images via sendPhoto (inline preview), everything else via
    // sendDocument. Both are multipart uploads of the raw bytes.
    for (const a of msg.attachments ?? []) {
      const isImage = a.mediaType.startsWith("image/");
      const method = isImage ? "sendPhoto" : "sendDocument";
      const field = isImage ? "photo" : "document";
      const form = new FormData();
      form.set("chat_id", externalUserId);
      if (a.caption) form.set("caption", a.caption);
      form.set(field, new Blob([a.data], { type: a.mediaType }), a.filename ?? "attachment");
      const res = await fetch(`${this.apiBase}/${method}`, { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        log.error(
          { status: res.status, body, method, filename: a.filename },
          "telegram attachment send failed",
        );
      }
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
    // Fail-closed authorization: drop anything from a chat id that isn't explicitly
    // allowlisted, BEFORE downloading any attachments. An unconfigured allowlist (null)
    // rejects everyone. The rejected id is logged so the operator can discover + add it.
    if (!this.allowedChatIds || !this.allowedChatIds.has(externalUserId)) {
      log.warn(
        { channel: this.id, chatId: externalUserId },
        "telegram: dropping message from non-allowlisted chat id (add it to channels.telegram.allowedChatIds to permit)",
      );
      return;
    }
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
