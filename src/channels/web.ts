import http from "node:http";
import type { Channel, ChannelContext, IncomingAttachment, OutgoingMessage } from "./base.js";
import { log } from "../log.js";

// Minimal HTTP+SSE channel.
//
// POST /messages
//   { externalUserId: string, text?: string, addressedTo?: string, attachments?: [{kind, mediaType, base64?}] }
// → 202 Accepted (the agent runs asynchronously; replies arrive on the SSE stream).
//
// GET /events?externalUserId=...
//   text/event-stream — receives outbound messages destined for that user.
//
// Auth: a bearer token (config.web.token) is required if set.
export class WebChannel implements Channel {
  readonly id = "web";
  readonly defaultAgent: string;
  private server: http.Server | null = null;
  private streams = new Map<string, http.ServerResponse>();
  private port: number;
  private token: string | undefined;

  constructor(opts: { defaultAgent: string; port?: number; token?: string }) {
    this.defaultAgent = opts.defaultAgent;
    this.port = opts.port ?? 8765;
    this.token = opts.token;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      try {
        if (this.token) {
          const auth = req.headers.authorization;
          if (auth !== `Bearer ${this.token}`) {
            res.writeHead(401);
            res.end("unauthorized");
            return;
          }
        }
        if (req.method === "POST" && req.url === "/messages") {
          await this.handlePost(req, res, ctx);
          return;
        }
        if (req.method === "GET" && req.url?.startsWith("/events")) {
          this.handleSse(req, res);
          return;
        }
        res.writeHead(404);
        res.end("not found");
      } catch (err) {
        log.error({ err }, "web channel error");
        res.writeHead(500);
        res.end("internal error");
      }
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, () => resolve()));
    log.info({ port: this.port }, "web channel listening");
  }

  async stop(): Promise<void> {
    for (const r of this.streams.values()) r.end();
    this.streams.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  async send(externalUserId: string, msg: OutgoingMessage): Promise<void> {
    const stream = this.streams.get(externalUserId);
    if (!stream) return; // user not connected; drop silently
    const data = JSON.stringify({ text: msg.text ?? "", parts: msg.parts ?? [] });
    stream.write(`event: message\ndata: ${data}\n\n`);
  }

  private async handlePost(req: http.IncomingMessage, res: http.ServerResponse, ctx: ChannelContext): Promise<void> {
    const body = await readJson(req);
    const externalUserId = String(body.externalUserId ?? "");
    if (!externalUserId) {
      res.writeHead(400);
      res.end("externalUserId required");
      return;
    }
    const attachments: IncomingAttachment[] = [];
    for (const a of (body.attachments ?? []) as Array<{
      kind: IncomingAttachment["kind"];
      mediaType: string;
      filename?: string;
      base64?: string;
      url?: string;
    }>) {
      if (a.base64) {
        attachments.push({
          kind: a.kind,
          mediaType: a.mediaType,
          ...(a.filename ? { filename: a.filename } : {}),
          data: Buffer.from(a.base64, "base64"),
        });
      } else if (a.url) {
        attachments.push({
          kind: a.kind,
          mediaType: a.mediaType,
          ...(a.filename ? { filename: a.filename } : {}),
          url: a.url,
        });
      }
    }
    await ctx.publish({
      channel: this.id,
      externalUserId,
      ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(typeof body.addressedTo === "string" ? { addressedTo: body.addressedTo } : {}),
      ...(typeof body.externalMessageId === "string" ? { externalMessageId: body.externalMessageId } : {}),
      ...(attachments.length ? { attachments } : {}),
      receivedAt: new Date().toISOString(),
    });
    res.writeHead(202);
    res.end("accepted");
  }

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const externalUserId = url.searchParams.get("externalUserId");
    if (!externalUserId) {
      res.writeHead(400);
      res.end("externalUserId required");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write(`: connected\n\n`);
    this.streams.set(externalUserId, res);
    req.on("close", () => this.streams.delete(externalUserId));
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
}
