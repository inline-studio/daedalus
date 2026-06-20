import http from "node:http";
import type { Channel, ChannelContext, IncomingAttachment, OutgoingMessage } from "./base.js";
import type { ContentPart, TurnEventSink } from "../types.js";
import { COMPACTION_CHANNEL, type SessionStore, type PersistedSession } from "../sessions/store.js";
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

// A slash-command entry served by GET /commands (name + description + aliases — what the
// UI's autocomplete needs; the body stays server-side).
export interface WebCommandInfo {
  name: string;
  description: string;
  aliases: string[];
}

// Commands handled by the supervisor itself (see agent-turn's /compact short-circuit) —
// always available, no brain definition needed.
const BUILTIN_COMMANDS: WebCommandInfo[] = [
  {
    name: "compact",
    description: "Summarise the conversation so far; the assistant continues from the summary",
    aliases: [],
  },
];

export class WebChannel implements Channel {
  readonly id = "web";
  readonly defaultAgent: string;
  private server: http.Server | null = null;
  // Live SSE connections, keyed by streamKey(externalUserId, conversationId) — i.e. per
  // (user, conversation), not just per user. One user can have MANY connections (multiple
  // tabs, a reconnect, a curl test) and now ALSO several conversations open at once; keying
  // by conversation means a reply is delivered only to the tab(s) showing that conversation
  // rather than broadcast across all of them. Each key holds a Set so multiple tabs on the
  // same conversation all stay in sync. A connection from an older cached UI that doesn't
  // send a conversationId registers under the bare externalUserId key (see streamsFor).
  private streams = new Map<string, Set<http.ServerResponse>>();
  private port: number;
  private token: string | undefined;
  private auth: WebAuth | undefined;
  private sessions: SessionStore | undefined;
  private heartbeatMs!: number;
  // Labels for the "copy conversation" transcript (the attributed Telegram-style export).
  private assistantName: string;
  private userName: string | undefined;
  private listCommands: (() => Promise<WebCommandInfo[]>) | undefined;

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
    // Slash-commands available to the default agent, for GET /commands (powers the UI's
    // autocomplete). Injected by the registry so the channel stays brain-agnostic.
    listCommands?: () => Promise<WebCommandInfo[]>;
  }) {
    this.defaultAgent = opts.defaultAgent;
    this.port = opts.port ?? 8765;
    this.token = opts.token;
    this.auth = opts.auth;
    this.sessions = opts.sessions;
    this.heartbeatMs = opts.heartbeatMs ?? 20_000;
    this.assistantName = opts.assistantName ?? "Artemis";
    this.userName = opts.userName;
    this.listCommands = opts.listCommands;
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
        if (pathname === "/conversations") {
          await this.handleConversations(req, res, url, loginUser);
          return;
        }
        if (req.method === "GET" && pathname === "/commands") {
          // Slash-commands for the UI's autocomplete: the built-ins (handled by the
          // supervisor, available regardless of the brain) plus the default agent's own,
          // loaded from the brain per request so edits to <brain>/commands/ show up live.
          const brainCommands = this.listCommands ? await this.listCommands().catch(() => []) : [];
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ commands: [...BUILTIN_COMMANDS, ...brainCommands] }));
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
    const targets = this.streamsFor(externalUserId, msg.conversationId);
    if (targets.length === 0) return; // not connected; dropped reply will be replayed on reconnect via Last-Event-ID
    const data = JSON.stringify({
      text: msg.text ?? "",
      parts: msg.parts ?? [],
      // Carry the conversation id so a client can tell which conversation a reply belongs to
      // (defensive — routing already targets the right stream). Null for non-conversation sends.
      conversationId: msg.conversationId ?? null,
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
    // Deliver to every matching connection (all tabs on this conversation stay in sync).
    for (const set of targets) for (const stream of set) stream.write(block);
  }

  // Live token streaming → transient SSE events the browser renders incrementally. Maps each
  // TurnEvent to a named SSE event (delta/thinking/tool/turn_done). These carry NO `id:` line: they
  // are ephemeral display, not part of the Last-Event-ID replay contract — the final reply is
  // persisted to the session and reloaded from history on reconnect, so nothing is lost.
  streamSink(externalUserId: string, conversationId?: string): TurnEventSink {
    return (ev) => {
      switch (ev.type) {
        case "text_delta":
          this.sseEvent(externalUserId, conversationId, "delta", { text: ev.text });
          break;
        case "thinking_delta":
          this.sseEvent(externalUserId, conversationId, "thinking", { text: ev.text });
          break;
        case "tool_use":
          // Carry the parsed input so the client can show the call detail (e.g. the fetched URL).
          this.sseEvent(externalUserId, conversationId, "tool", {
            id: ev.id,
            name: ev.name,
            input: ev.input,
          });
          break;
        case "tool_result":
          // Resolve the matching tool row to done / error.
          this.sseEvent(externalUserId, conversationId, "tool_done", {
            id: ev.id,
            isError: ev.isError,
          });
          break;
        case "turn_complete":
          // Carry the authoritative final text so the client can finalize the streamed bubble
          // exactly (and dedup it against a reconnect replay of the persisted reply), plus the
          // aggregate token usage for the Claude-style readout.
          this.sseEvent(externalUserId, conversationId, "turn_done", {
            text: ev.finalText,
            ...(ev.usage ? { usage: ev.usage } : {}),
          });
          break;
        case "debug_log":
          this.sseEvent(externalUserId, conversationId, "debug", { path: ev.path });
          break;
      }
    };
  }

  private sseEvent(
    externalUserId: string,
    conversationId: string | undefined,
    event: string,
    payload: Record<string, unknown>,
  ): void {
    const targets = this.streamsFor(externalUserId, conversationId);
    if (targets.length === 0) return;
    const data = JSON.stringify({ ...payload, conversationId: conversationId ?? null });
    const block = `event: ${event}\ndata: ${data}\n\n`;
    for (const set of targets) for (const stream of set) stream.write(block);
  }

  // The streams map key for a (user, conversation). A bare externalUserId (no conversationId)
  // is the legacy key used by older cached UIs that predate conversations. The separator is a
  // NUL — it can't appear in a username or a UUID conversation id, so the startsWith() prefix
  // match in streamsFor can't bleed across similarly-named users.
  private streamKey(externalUserId: string, conversationId: string | undefined): string {
    return conversationId ? externalUserId + "\u0000" + conversationId : externalUserId;
  }

  // The connection Sets a reply should go to. With a conversationId: the exact per-conversation
  // stream PLUS any legacy bare-key stream for the same user (so an un-refreshed old UI still
  // receives replies during a deploy). Without one: every stream belonging to the user.
  private streamsFor(
    externalUserId: string,
    conversationId: string | undefined,
  ): Set<http.ServerResponse>[] {
    const out: Set<http.ServerResponse>[] = [];
    if (conversationId) {
      const exact = this.streams.get(this.streamKey(externalUserId, conversationId));
      if (exact) out.push(exact);
      const legacy = this.streams.get(externalUserId);
      if (legacy) out.push(legacy);
    } else {
      const prefix = externalUserId + "\u0000";
      for (const [k, set] of this.streams) {
        if (k === externalUserId || k.startsWith(prefix)) out.push(set);
      }
    }
    return out;
  }

  // Resolve the session a web request targets, enforcing ownership. With a conversationId,
  // returns that session ONLY if it belongs to (user, defaultAgent); an unknown / forbidden id
  // falls back to the default ("Main") session. Returns null only when no SessionStore is wired.
  private resolveConversation(
    externalUserId: string,
    conversationId: string | null | undefined,
  ): PersistedSession | null {
    if (!this.sessions) return null;
    const userId = this.sessions.resolveUser(this.id, externalUserId);
    if (conversationId) {
      const s = this.sessions.getSessionById(conversationId);
      if (s && s.userId === userId && s.agentName === this.defaultAgent) return s;
    }
    return this.sessions.getOrCreateSession(userId, this.defaultAgent);
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
    // A client-supplied conversation id is only forwarded if it belongs to this user (ingest
    // re-validates, but checking here keeps a forged id from even reaching the pipeline). An
    // invalid/absent id is simply dropped, so the message lands in the default ("Main") session.
    let conversationId: string | undefined;
    if (typeof body.conversationId === "string" && body.conversationId && this.sessions) {
      const userId = this.sessions.resolveUser(this.id, externalUserId);
      const s = this.sessions.getSessionById(body.conversationId);
      if (s && s.userId === userId) conversationId = body.conversationId;
    }
    await ctx.publish({
      channel: this.id,
      externalUserId,
      ...(typeof body.text === "string" ? { text: body.text } : {}),
      ...(conversationId ? { conversationId } : {}),
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
    // Which conversation this stream is for. Resolve it to an owned session up front so both
    // the reconnect replay and the stream-key registration use the same one. A client that
    // doesn't send a conversationId (older cached UI) gets the default session and registers
    // under the bare-user legacy key.
    const reqConversationId = url.searchParams.get("conversationId");
    const session = this.resolveConversation(externalUserId, reqConversationId);
    const streamConversationId = session ? session.id : reqConversationId ?? undefined;
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
    if (typeof lastEventId === "string" && lastEventId && this.sessions && session) {
      try {
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

    // Add THIS connection to the (user, conversation) set (don't replace — other tabs/
    // reconnects on the same conversation coexist).
    const key = this.streamKey(externalUserId, streamConversationId);
    let set = this.streams.get(key);
    if (!set) {
      set = new Set();
      this.streams.set(key, set);
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
      // Remove only THIS connection from its (user, conversation) set (leave others intact).
      const s = this.streams.get(key);
      if (s) {
        s.delete(res);
        if (s.size === 0) this.streams.delete(key);
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
    // `blocks` (assistant only) reconstructs the live activity chrome on reload: an ordered list
    // of text / thinking / tool entries so the client can re-render reasoning + tool rows, not just
    // flattened text. `text` is still sent for the copy transcript and user/notice rows.
    type HistoryBlock =
      | { t: "text"; text: string }
      | { t: "thinking"; text: string }
      | { t: "tool"; name: string; input: unknown; isError: boolean };
    let messages: Array<{ role: string; text: string; at?: string; blocks?: HistoryBlock[] }> = [];
    if (this.sessions) {
      try {
        // Replay the requested conversation (validated to belong to the user; an unknown id
        // falls back to the default/"Main" session).
        const session = this.resolveConversation(externalUserId, url.searchParams.get("conversationId"));
        if (!session) throw new Error("no session");
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
        const rows = this.sessions
          .tail(session.id, RAW_TAIL)
          .filter((m) => m.role === "user" || m.role === "assistant");
        // Resolve each tool_use's outcome (ok/error) from the tool_result rows so the
        // reconstructed tool rows show ✓/✗ on reload.
        const toolErr = new Map<string, boolean>();
        for (const m of rows) {
          for (const p of m.content) {
            if (p.type === "tool_result") toolErr.set(p.toolUseId, Boolean(p.isError));
          }
        }
        messages = rows
          // Carry createdAt through as `at` so the client can render the attributed,
          // timestamped "copy conversation" transcript. The chat bubbles ignore it.
          // Compaction markers ride as user-role rows but aren't anything the user said —
          // surface them as role "notice" so the UI renders them as a system line.
          .map((m) => {
            if (m.channel === COMPACTION_CHANNEL) {
              return { role: "notice", text: partsToText(m.content), at: m.createdAt };
            }
            const text = partsToText(m.content);
            if (m.role !== "assistant") return { role: m.role as string, text, at: m.createdAt };
            // Assistant: reconstruct the inline flow (thinking / text / tool rows) in order.
            const blocks: HistoryBlock[] = [];
            for (const p of m.content) {
              if (p.type === "thinking" && !p.redacted && p.thinking.trim()) {
                blocks.push({ t: "thinking", text: p.thinking });
              } else if (p.type === "text" && p.text.trim()) {
                blocks.push({ t: "text", text: p.text });
              } else if (p.type === "tool_use") {
                blocks.push({ t: "tool", name: p.name, input: p.input, isError: toolErr.get(p.id) ?? false });
              }
            }
            return { role: "assistant", text, at: m.createdAt, ...(blocks.length ? { blocks } : {}) };
          })
          // Keep anything with visible text OR reconstructable blocks (tool-only turns have no text).
          .filter((m) => m.text.length > 0 || (m.blocks?.length ?? 0) > 0)
          .slice(-VISIBLE_CAP);
      } catch (err) {
        log.warn({ err }, "web channel: history read failed");
      }
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ messages }));
  }

  // Conversation management for the web UI's separate-sessions feature.
  //   GET    /conversations           → { conversations: [{id,title,createdAt,lastActiveAt}], defaultId }
  //   POST   /conversations           → create a new conversation, returns the created entry
  //   DELETE /conversations?id=<id>   → delete a conversation (the default/"Main" one is cleared
  //                                     instead of dropped — see the handler comment)
  // All operate on the (user, defaultAgent) the page is bound to; ownership is enforced via the
  // resolved user so a client can't touch another user's conversations.
  private async handleConversations(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    url: URL,
    forcedUser: string | null,
  ): Promise<void> {
    const externalUserId = forcedUser ?? url.searchParams.get("externalUserId");
    if (!externalUserId) {
      res.writeHead(400);
      res.end("externalUserId required");
      return;
    }
    if (!this.sessions) {
      // No store wired (e.g. a bare smoke harness) — report just a virtual default.
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ conversations: [], defaultId: null }));
      return;
    }
    const sessions = this.sessions;
    const userId = sessions.resolveUser(this.id, externalUserId);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const toEntry = (s: PersistedSession) => ({
      id: s.id,
      title: s.title,
      createdAt: s.createdAt,
      lastActiveAt: s.lastActiveAt,
    });

    if (req.method === "GET") {
      // Ensure the default/"Main" session exists so the UI always has at least one conversation,
      // and so a brand-new browser gets a stable id to talk to.
      const def = sessions.getOrCreateSession(userId, this.defaultAgent);
      const conversations = sessions.listSessions(userId, this.defaultAgent).map(toEntry);
      json(200, { conversations, defaultId: def.id });
      return;
    }
    if (req.method === "POST") {
      const body = await readJson(req).catch(() => ({}) as Record<string, unknown>);
      const title =
        typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 80) : undefined;
      // Guardrail: don't pile up empty conversations. If the user already has an unused
      // (zero-message) non-default conversation, hand that one back instead of creating
      // another — this is what makes repeated "New chat" clicks reuse the one blank chat.
      // (Skipped when an explicit title is supplied, i.e. a deliberate named conversation.)
      if (!title) {
        const def = sessions.getOrCreateSession(userId, this.defaultAgent);
        const reusable = sessions
          .listSessions(userId, this.defaultAgent)
          .find((s) => s.id !== def.id && sessions.countMessages(s.id) === 0);
        if (reusable) {
          json(200, toEntry(reusable));
          return;
        }
      }
      const created = sessions.createSession(userId, this.defaultAgent, title);
      json(200, toEntry(created));
      return;
    }
    if (req.method === "DELETE") {
      const id = url.searchParams.get("id");
      if (!id) {
        json(400, { error: "id required" });
        return;
      }
      const s = sessions.getSessionById(id);
      if (!s || s.userId !== userId || s.agentName !== this.defaultAgent) {
        json(404, { error: "not found" });
        return;
      }
      // The default/"Main" conversation's ROW must survive: it's shared with non-web channels
      // and getOrCreateSession resolves the default as the oldest session, so dropping the row
      // would silently promote another web conversation to be every channel's default. "Delete"
      // on Main therefore clears its history instead; the conversation entry stays.
      const def = sessions.getOrCreateSession(userId, this.defaultAgent);
      if (s.id === def.id) {
        sessions.clearSessionMessages(id);
        json(200, { ok: true, cleared: true });
        return;
      }
      sessions.deleteSession(id);
      json(200, { ok: true });
      return;
    }
    res.writeHead(405);
    res.end("method not allowed");
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
