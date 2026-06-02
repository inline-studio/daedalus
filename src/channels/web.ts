import http from "node:http";
import type { Channel, ChannelContext, IncomingAttachment, OutgoingMessage } from "./base.js";
import type { ContentPart } from "../types.js";
import type { SessionStore } from "../sessions/store.js";
import { WEB_UI_HTML, WEB_LOGIN_HTML } from "./web-ui.js";
import { verifyPassword, signSession, verifySession, parseCookies } from "./web-auth.js";
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
// Auth — one of three modes:
//   - login: when web.auth (username + passwordHash + sessionSecret) is configured, the UI
//     gets its own /login page; a signed httpOnly cookie gates every route and the bearer
//     token is ignored. The authenticated username IS the externalUserId (clients can't
//     impersonate another user).
//   - token: when only web.token is set, a bearer token gates the API (UI shell stays open).
//   - open: neither set — everything is open (front it with your own proxy).
const SESSION_COOKIE = "dae_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface WebAuth {
  username: string;
  passwordHash: string;
  sessionSecret: string;
}

export class WebChannel implements Channel {
  readonly id = "web";
  readonly defaultAgent: string;
  private server: http.Server | null = null;
  // One user can have MANY live SSE connections (multiple tabs, a reconnect, even a curl test).
  // In login mode the key is the username, so they ALL share a key — keying a single response
  // per user makes connections evict each other and orphan the live one. Hold a Set per user
  // and broadcast every reply to all of them.
  private streams = new Map<string, Set<http.ServerResponse>>();
  private port: number;
  private token: string | undefined;
  private auth: WebAuth | undefined;
  private sessions: SessionStore | undefined;
  private heartbeatMs!: number;
  // Labels for the "copy conversation" transcript (the attributed Telegram-style export).
  private assistantName: string;
  private userName: string | undefined;

  constructor(opts: {
    defaultAgent: string;
    port?: number;
    token?: string;
    auth?: WebAuth;
    sessions?: SessionStore;
    // SSE heartbeat interval in ms (default 20_000). Tests override this so
    // they can verify the wire format without waiting 20s per assertion.
    heartbeatMs?: number;
    // The assistant's user-facing name (config.identity.name). Used to label assistant
    // lines in the copy-conversation transcript. Defaults to "Artemis".
    assistantName?: string;
    // Optional display name for the human in that transcript. Falls back to the logged-in
    // username (login mode) or "You".
    userName?: string;
  }) {
    this.defaultAgent = opts.defaultAgent;
    this.port = opts.port ?? 8765;
    this.token = opts.token;
    this.auth = opts.auth;
    this.sessions = opts.sessions;
    this.heartbeatMs = opts.heartbeatMs ?? 20_000;
    this.assistantName = opts.assistantName ?? "Artemis";
    this.userName = opts.userName;
  }

  async start(ctx: ChannelContext): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
        const pathname = url.pathname;
        const loginMode = Boolean(this.auth);

        // --- Login mode: unauthenticated login routes, served before the gate ---
        if (loginMode) {
          if (req.method === "GET" && (pathname === "/login" || pathname === "/login.html")) {
            res.writeHead(200, htmlHeaders());
            res.end(WEB_LOGIN_HTML);
            return;
          }
          if (req.method === "POST" && pathname === "/login") {
            await this.handleLogin(req, res);
            return;
          }
          if (req.method === "POST" && pathname === "/logout") {
            res.writeHead(204, { "Set-Cookie": this.cookie("", 0, req) });
            res.end();
            return;
          }
        }

        // Resolve the authenticated user from the session cookie (login mode only).
        const loginUser = loginMode ? this.sessionUser(req) : null;

        // Serve the chat UI shell. In login mode it requires a valid session (redirect to
        // /login otherwise); in token/open mode it's served unauthenticated so the page can
        // load and then authenticate its own API calls.
        if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
          if (loginMode && !loginUser) {
            res.writeHead(302, { Location: "/login" });
            res.end();
            return;
          }
          res.writeHead(200, htmlHeaders());
          res.end(this.renderShell(loginUser));
          return;
        }

        // --- Gate the API routes ---
        if (loginMode) {
          if (!loginUser) {
            res.writeHead(401);
            res.end("unauthorized");
            return;
          }
        } else if (this.token) {
          // fetch() sends `Authorization: Bearer …`; EventSource can't set headers, so also
          // accept `?token=…`.
          const viaHeader = req.headers.authorization === `Bearer ${this.token}`;
          const viaQuery = url.searchParams.get("token") === this.token;
          if (!viaHeader && !viaQuery) {
            res.writeHead(401);
            res.end("unauthorized");
            return;
          }
        }

        if (req.method === "POST" && pathname === "/messages") {
          await this.handlePost(req, res, ctx, loginUser);
          return;
        }
        if (req.method === "GET" && pathname === "/events") {
          this.handleSse(req, res, loginUser);
          return;
        }
        if (req.method === "GET" && pathname === "/history") {
          this.handleHistory(url, res, loginUser);
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
    const mode = this.auth ? "login" : this.token ? "token" : "open";
    log.info({ port: this.port, auth: mode }, "web channel listening");
  }

  async stop(): Promise<void> {
    for (const set of this.streams.values()) for (const r of set) r.end();
    this.streams.clear();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
    this.server = null;
  }

  async send(externalUserId: string, msg: OutgoingMessage): Promise<void> {
    const set = this.streams.get(externalUserId);
    if (!set || set.size === 0) return; // user not connected; dropped reply will be replayed on reconnect via Last-Event-ID
    const data = JSON.stringify({
      text: msg.text ?? "",
      parts: msg.parts ?? [],
      attachments: (msg.attachments ?? []).map((a) => ({
        mediaType: a.mediaType,
        ...(a.filename ? { filename: a.filename } : {}),
        ...(a.caption ? { caption: a.caption } : {}),
        base64: a.data.toString("base64"),
      })),
    });
    // Tag with an `id:` line so the browser's EventSource sets `Last-Event-ID`
    // on the next reconnect. We use the server's send time, not the persisted
    // message id, because `send()` doesn't know which persisted message it's
    // emitting — but send time is monotonically after the message's createdAt
    // (single-writer supervisor), so a "messages with createdAt > sendTime"
    // filter on reconnect is a SUPERSET of "messages this stream missed,"
    // never a subset. The handleSse replay uses that filter.
    const sseId = new Date().toISOString();
    const block = `id: ${sseId}\nevent: message\ndata: ${data}\n\n`;
    // Broadcast to every live connection for this user (all tabs/devices stay in sync).
    for (const stream of set) stream.write(block);
  }

  // Verify the session cookie and return the authenticated username, or null.
  private sessionUser(req: http.IncomingMessage): string | null {
    if (!this.auth) return null;
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return token ? verifySession(token, this.auth.sessionSecret) : null;
  }

  // Build the session Set-Cookie value. maxAgeMs <= 0 clears it. Secure is set when the
  // request reached us over https (Caddy/your proxy sets x-forwarded-proto).
  private cookie(value: string, maxAgeMs: number, req: http.IncomingMessage): string {
    const https = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https";
    const parts = [
      `${SESSION_COOKIE}=${value}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${Math.max(0, Math.floor(maxAgeMs / 1000))}`,
    ];
    if (https) parts.push("Secure");
    return parts.join("; ");
  }

  private async handleLogin(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!this.auth) {
      res.writeHead(404);
      res.end();
      return;
    }
    const body = await readJson(req);
    const username = String(body.username ?? "");
    const password = String(body.password ?? "");
    const okUser = username === this.auth.username;
    // Always run the hash compare (even on a wrong username) to avoid leaking which half failed.
    const okPass = verifyPassword(password, this.auth.passwordHash);
    if (!okUser || !okPass) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "invalid credentials" }));
      return;
    }
    const token = signSession(this.auth.username, this.auth.sessionSecret, SESSION_TTL_MS);
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": this.cookie(token, SESSION_TTL_MS, req),
    });
    res.end(JSON.stringify({ ok: true }));
  }

  // Inject the active auth mode + the transcript speaker labels into the served shell. The UI
  // uses the mode to hide the token field (login mode) and show a Logout button; the names
  // label the "copy conversation" export. The user label resolves: configured userName →
  // logged-in username (login mode) → "You". Function replacers avoid `$&`-style surprises
  // if a name contains a dollar sign, and jsStringLiteral keeps the values safe inside the
  // double-quoted JS string they land in.
  private renderShell(loginUser?: string | null): string {
    const mode = this.auth ? "login" : this.token ? "token" : "open";
    const user = this.userName ?? loginUser ?? "You";
    return WEB_UI_HTML.replace("__DAE_WEB_MODE__", () => mode)
      .replace("__DAE_ASSISTANT_NAME__", () => jsStringLiteral(this.assistantName))
      .replace("__DAE_USER_NAME__", () => jsStringLiteral(user));
  }

  private async handlePost(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    ctx: ChannelContext,
    forcedUser: string | null,
  ): Promise<void> {
    const body = await readJson(req);
    // In login mode the authenticated username IS the user — the client can't choose it.
    const externalUserId = forcedUser ?? String(body.externalUserId ?? "");
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

  private handleSse(req: http.IncomingMessage, res: http.ServerResponse, forcedUser: string | null): void {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const externalUserId = forcedUser ?? url.searchParams.get("externalUserId");
    if (!externalUserId) {
      res.writeHead(400);
      res.end("externalUserId required");
      return;
    }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      // Tell nginx-style proxies never to buffer this stream (Caddy honours flush_interval -1).
      "X-Accel-Buffering": "no",
    });
    res.write(`: connected\n\n`);

    // Replay anything the browser missed during a reconnect gap.
    //
    // EventSource auto-reconnects after a transient drop (proxy timeout, network
    // blip, supervisor restart). If the agent replied during that window,
    // send() wrote to a dead stream and the message was lost — the user would
    // only see it after a manual page refresh that hit /history.
    //
    // The browser sends `Last-Event-ID: <iso>` on reconnect, carrying the `id:`
    // line of the most recent event it processed. We use that as a watermark
    // into the session store and replay any messages persisted since.
    //
    // Replay is text-only — attachments live in the AttachmentStore (not in
    // the persisted message content) and the live SSE path serialises them
    // by re-reading bytes from disk; we don't reconstruct that here. Same
    // limitation as the /history endpoint. A page refresh still shows them.
    const lastEventId = req.headers["last-event-id"];
    if (typeof lastEventId === "string" && lastEventId && this.sessions) {
      try {
        const userId = this.sessions.resolveUser(this.id, externalUserId);
        const session = this.sessions.getOrCreateSession(userId, this.defaultAgent);
        const missed = this.sessions.messagesSince(session.id, lastEventId, 200);
        for (const m of missed) {
          if (m.role !== "assistant") continue; // user msgs were rendered locally on send
          const text = partsToText(m.content);
          if (!text) continue;
          const data = JSON.stringify({ text, parts: [], attachments: [] });
          res.write(`id: ${m.createdAt}\nevent: message\ndata: ${data}\n\n`);
        }
      } catch (err) {
        log.warn({ err, externalUserId }, "SSE replay-since failed; continuing live");
      }
    }

    // Add THIS connection to the user's set (don't replace — other tabs/reconnects coexist).
    let set = this.streams.get(externalUserId);
    if (!set) {
      set = new Set();
      this.streams.set(externalUserId, set);
    }
    set.add(res);

    // Heartbeat. An agent turn can take tens of seconds (large context on a CPU model),
    // during which NO data flows on this stream. Without periodic traffic a proxy/keepalive
    // timeout silently drops the idle connection — and then the eventual reply is written
    // to a dead stream and lost.
    //
    // Emitted as a NAMED event (not an SSE `: ping` comment) so the browser's EventSource
    // surfaces it to JS — the client uses it to drive a watchdog that force-reconnects if
    // heartbeats stop arriving, which is the only way to recover from a proxy (e.g. Caddy
    // mid-request idle-timeout) that has silently torn down the socket but left the
    // browser thinking it's connected. Crucially the heartbeat has NO `id:` line, so it
    // doesn't disturb Last-Event-ID — replay-on-reconnect (see above) still works.
    //
    // unref() so the timer never holds the process open on its own.
    const heartbeat = setInterval(() => {
      try {
        res.write(`event: heartbeat\ndata: {}\n\n`);
      } catch {
        /* stream gone — the close handler will clean up */
      }
    }, this.heartbeatMs);
    if (typeof heartbeat.unref === "function") heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      // Remove only THIS connection from the user's set (leave other tabs/reconnects intact).
      const s = this.streams.get(externalUserId);
      if (s) {
        s.delete(res);
        if (s.size === 0) this.streams.delete(externalUserId);
      }
    };
    req.on("close", cleanup);
    res.on("close", cleanup);
  }

  // Replay recent session messages so the UI shows history across reloads. This is the
  // REAL session (same one Telegram etc. write to), not a per-browser cache — so a reply
  // received on another channel shows up here too. Empty if no SessionStore is wired.
  private handleHistory(url: URL, res: http.ServerResponse, forcedUser: string | null): void {
    const externalUserId = forcedUser ?? url.searchParams.get("externalUserId");
    if (!externalUserId) {
      res.writeHead(400);
      res.end("externalUserId required");
      return;
    }
    let messages: Array<{ role: string; text: string; at?: string }> = [];
    if (this.sessions) {
      try {
        const userId = this.sessions.resolveUser(this.id, externalUserId);
        const session = this.sessions.getOrCreateSession(userId, this.defaultAgent);
        // Tool-using turns put TWO rows into the messages table per turn: the
        // assistant message (text + tool_use parts) AND a synthetic "user"
        // message holding the tool_results (no text, filtered out below).
        // A 10-step droplet-creation turn writes ~21 rows of which only ~11
        // are visible.
        //
        // The previous tail(50) limit was therefore much too small: in a
        // session that's had a handful of tool-heavy conversations, the user's
        // own text messages get pushed clean out of the 50-row window. Scott
        // saw exactly this — /history returned 10 assistant messages and zero
        // of his own questions, because his questions were >50 rows back.
        //
        // Pull a much larger raw window, filter to visibles, then cap. 1000
        // raw rows comfortably covers any realistic tool-heavy session; the
        // 200-visible cap bounds the response size (~50-200KB worst case).
        const RAW_TAIL = 1000;
        const VISIBLE_CAP = 200;
        messages = this.sessions
          .tail(session.id, RAW_TAIL)
          .filter((m) => m.role === "user" || m.role === "assistant")
          // Carry createdAt through as `at` so the client can render the attributed,
          // timestamped "copy conversation" transcript. The chat bubbles ignore it.
          .map((m) => ({ role: m.role as string, text: partsToText(m.content), at: m.createdAt }))
          .filter((m) => m.text.length > 0)
          .slice(-VISIBLE_CAP);
      } catch (err) {
        log.warn({ err }, "web channel: history read failed");
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages }));
  }
}

// Response headers for the shell HTML (chat UI + login page).
//
// The shell embeds every CSS rule and every line of client JS inline, so a
// `dae update` only takes effect once the browser fetches a fresh copy.
// Without a Cache-Control header browsers fall back to heuristic caching —
// often hours, sometimes days — which means a user is left on the OLD JS
// even after the supervisor was rebuilt with a new version. (Scott hit this
// after PR #82: server had the new code, his browser still had the old.)
//
// `no-cache, no-store, must-revalidate` is overkill for an HTML response but
// the right kind of overkill: the file is ~30KB, refetching costs nothing,
// and Cloudflare / corporate proxies along the way all honour at least one
// of those directives. `Pragma: no-cache` + `Expires: 0` cover ancient HTTP/1
// proxies belt-and-braces.
function htmlHeaders(): Record<string, string> {
  return {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  };
}

// Escape a string for safe embedding inside a double-quoted JS string literal in the
// served HTML shell (the `var ASSISTANT_NAME = "…"` injection). Collapses newlines and
// neutralises `<` so a crafted name can't break out of the <script> or the string.
function jsStringLiteral(s: string): string {
  return String(s)
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, " ")
    .replace(/</g, "\\u003c");
}

// Flatten a message's content parts to plain text for the history view (the live SSE
// stream carries attachments; history is text-only).
function partsToText(content: ContentPart[]): string {
  return content.map((p) => (p.type === "text" ? p.text : "")).join("");
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const buf = Buffer.concat(chunks);
  if (!buf.length) return {};
  return JSON.parse(buf.toString("utf8")) as Record<string, unknown>;
}
