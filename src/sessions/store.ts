import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import type { Message, ContentPart } from "../types.js";

// Unified session store. There is NO partitioning by channel — a message that arrives
// via Telegram and a message via Web for the same user share the same session history,
// keyed by (user_id, agent_name).
//
// Identity: a user_identity row maps (channel, external_id) -> user_id. The first time
// we see a channel/external pair we create a new user; admins can later merge users
// (not implemented in v0.1).
//
// Outbound routing: each persisted message records the inbound channel + external_message_id.
// For agent-initiated outbound, we look up the user's most-recent inbound channel.

// `channel` value marking a compaction marker message: a user-role row whose text is a
// model-written summary of everything before it. Replay (agent-turn) cuts the loaded tail
// at the latest marker; the web UI renders it as a notice instead of a chat bubble.
export const COMPACTION_CHANNEL = "compaction";

export interface PersistedMessage {
  id: string;
  sessionId: string;
  role: Message["role"];
  channel: string | null;
  externalMessageId: string | null;
  content: ContentPart[];
  createdAt: string;
}

export interface PersistedSession {
  id: string;
  userId: string;
  agentName: string;
  // Human label for the conversation, shown in the web UI's conversation list. Null for the
  // default/"Main" session and until a freshly-created conversation gets its first message
  // (we auto-title from that). Non-web channels never set or read it.
  title: string | null;
  // Pinned conversations surface in the web UI sidebar's PINNED section. Web-only concept;
  // other channels ignore it.
  pinned: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export interface UserChannelBinding {
  userId: string;
  channel: string;
  externalId: string;
}

export class SessionStore {
  private db!: DatabaseSync;
  private readonly dbPath: string;
  // Inode + device of the file we opened. If the file at dbPath gets replaced
  // out from under us (e.g. by a reinstall / upgrade), our existing fd points
  // at a now-deleted inode and SQLite surfaces "attempt to write a readonly
  // database" the moment it tries to create a WAL/journal sibling. We
  // ensureFreshConnection() at the top of every public method — cheap fstat +
  // a reopen on mismatch.
  private openedInode = 0;
  private openedDev = 0;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.openConnection();
  }

  private openConnection(): void {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        /* old fd may already be invalid; ignore */
      }
    }
    // FK enforcement OFF. node:sqlite turns foreign keys ON by default, but this store has
    // always managed referential integrity by hand (e.g. deleteSession removes a session's
    // messages before the session row; there are no ON DELETE actions to honour). Enforcement
    // was therefore incidental — and actively harmful during a table rebuild, where dropping a
    // parent table mid-migration trips the constraint. Turning it off keeps rebuilds simple and
    // makes any historical dangling reference harmless.
    this.db = new DatabaseSync(this.dbPath, { enableForeignKeyConstraints: false });
    this.migrate();
    try {
      const st = fs.statSync(this.dbPath);
      this.openedInode = Number(st.ino);
      this.openedDev = Number(st.dev);
    } catch {
      // Couldn't stat — leave inode/dev at 0; next ensureFreshConnection() may reopen.
      this.openedInode = 0;
      this.openedDev = 0;
    }
  }

  // Cheap path-stat → inode comparison. If different (or file gone), close +
  // reopen. Called by every public method so a wizard / upgrade that replaces
  // the sqlite file doesn't leave the supervisor stuck on a deleted fd.
  private ensureFreshConnection(): void {
    let inode = 0;
    let dev = 0;
    try {
      const st = fs.statSync(this.dbPath);
      inode = Number(st.ino);
      dev = Number(st.dev);
    } catch {
      // File doesn't exist (got deleted entirely). Reopen will recreate it.
      this.openConnection();
      return;
    }
    if (inode !== this.openedInode || dev !== this.openedDev) {
      this.openConnection();
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS user_identities (
        user_id TEXT NOT NULL REFERENCES users(id),
        channel TEXT NOT NULL,
        external_id TEXT NOT NULL,
        PRIMARY KEY (channel, external_id)
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        agent_name TEXT NOT NULL,
        title TEXT,
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        role TEXT NOT NULL,
        channel TEXT,
        external_message_id TEXT,
        content_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session_created
        ON messages(session_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_sessions_user_agent
        ON sessions(user_id, agent_name, last_active_at);
    `);
    this.migrateSessionsMultiConversation();
  }

  // Run a multi-statement DDL block atomically: either it all applies or none of it does.
  // node:sqlite's exec() runs statements sequentially with NO implicit transaction, so a
  // failure partway would leave a half-rebuilt schema (exactly what broke an earlier version
  // of this migration). The explicit BEGIN/COMMIT — with ROLLBACK on error — prevents that.
  private execAtomic(sql: string): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec(sql);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* nothing to roll back */
      }
      throw err;
    }
  }

  // Upgrade a legacy `sessions` table to the multi-conversation schema, and self-heal a DB left
  // half-migrated by the first (buggy) version of this migration.
  //
  // The original table had `UNIQUE (user_id, agent_name)` and no `title` column. Supporting
  // several web conversations per (user, agent) means dropping that UNIQUE constraint, which
  // SQLite can only do by rebuilding the table.
  //
  // IMPORTANT — table-rebuild order. The first cut renamed the PARENT (`sessions` →
  // `sessions_legacy`) first; modern SQLite rewrites child foreign keys on rename, so
  // `messages` started referencing `sessions_legacy`, and the following DROP tripped the FK
  // check (foreign keys are ON by default in node:sqlite). We now (a) run with FK enforcement
  // off, and (b) use the SQLite-recommended order — create the new table, copy, DROP the old,
  // then RENAME the new into place — so child references keep pointing at "sessions".
  //
  // Self-heal covers DBs already damaged by the old code: a leftover `sessions_legacy` table
  // and/or a `messages` table whose FK was rewritten to `sessions_legacy`.
  private migrateSessionsMultiConversation(): void {
    // 1. Drop any leftover `sessions_legacy` from a previously-failed rebuild. Its rows were
    //    already copied into `sessions` before the old migration died, so this loses nothing.
    this.db.exec(`DROP TABLE IF EXISTS sessions_legacy`);

    // 2. If the old migration rewrote `messages`'s foreign key to point at `sessions_legacy`,
    //    rebuild `messages` so it references `sessions` again (purely a schema repair; rows are
    //    preserved). Detected by inspecting the stored CREATE statement.
    const messagesSql =
      (
        this.db
          .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'`)
          .get() as { sql?: string } | undefined
      )?.sql ?? "";
    if (/sessions_legacy/.test(messagesSql)) {
      this.execAtomic(`
        CREATE TABLE messages_new (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          role TEXT NOT NULL,
          channel TEXT,
          external_message_id TEXT,
          content_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO messages_new (id, session_id, role, channel, external_message_id, content_json, created_at)
          SELECT id, session_id, role, channel, external_message_id, content_json, created_at FROM messages;
        DROP TABLE messages;
        ALTER TABLE messages_new RENAME TO messages;
        CREATE INDEX IF NOT EXISTS idx_messages_session_created
          ON messages(session_id, created_at);
      `);
    }

    // 3. If `sessions` still has the legacy shape (no `title` column), rebuild it WITHOUT the
    //    UNIQUE(user_id, agent_name) constraint and WITH `title`. Correct order so `messages`'s
    //    FK keeps referencing "sessions".
    const cols = this.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "title")) {
      this.execAtomic(`
        CREATE TABLE sessions_new (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          agent_name TEXT NOT NULL,
          title TEXT,
          created_at TEXT NOT NULL,
          last_active_at TEXT NOT NULL
        );
        INSERT INTO sessions_new (id, user_id, agent_name, title, created_at, last_active_at)
          SELECT id, user_id, agent_name, NULL, created_at, last_active_at FROM sessions;
        DROP TABLE sessions;
        ALTER TABLE sessions_new RENAME TO sessions;
        CREATE INDEX IF NOT EXISTS idx_sessions_user_agent
          ON sessions(user_id, agent_name, last_active_at);
      `);
    }

    // 4. Pinned conversations (web sidebar). Additive column; runs after the title rebuild
    //    so a legacy DB picks it up in the same open.
    const colsAfter = this.db.prepare(`PRAGMA table_info(sessions)`).all() as Array<{ name: string }>;
    if (!colsAfter.some((c) => c.name === "pinned")) {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0`);
    }
  }

  private rowToSession(row: {
    id: string;
    user_id: string;
    agent_name: string;
    title: string | null;
    pinned?: number;
    created_at: string;
    last_active_at: string;
  }): PersistedSession {
    return {
      id: row.id,
      userId: row.user_id,
      agentName: row.agent_name,
      title: row.title,
      pinned: Boolean(row.pinned),
      createdAt: row.created_at,
      lastActiveAt: row.last_active_at,
    };
  }

  // Resolve a channel/external_id pair to a user_id, creating a user lazily.
  resolveUser(channel: string, externalId: string): string {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(`SELECT user_id FROM user_identities WHERE channel = ? AND external_id = ?`)
      .get(channel, externalId) as { user_id: string } | undefined;
    if (row) return row.user_id;

    const userId = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO users (id, created_at) VALUES (?, ?)`).run(userId, now);
    this.db
      .prepare(`INSERT INTO user_identities (user_id, channel, external_id) VALUES (?, ?, ?)`)
      .run(userId, channel, externalId);
    return userId;
  }

  // Link an existing user to another channel binding (for cross-channel identity merge).
  linkIdentity(userId: string, channel: string, externalId: string): void {
    this.ensureFreshConnection();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO user_identities (user_id, channel, external_id) VALUES (?, ?, ?)`,
      )
      .run(userId, channel, externalId);
  }

  // Get-or-create the DEFAULT ("Main") session for a (user, agent).
  //
  // Since a (user, agent) can now own several sessions (web conversations), "the" session
  // is ambiguous — we define the default as the OLDEST one. That's the session that existed
  // before multi-conversation support, so existing histories keep resolving to it, and every
  // non-web channel (Telegram/WhatsApp/CLI/scheduler) continues to read & write here.
  getOrCreateSession(userId: string, agentName: string): PersistedSession {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(
        `SELECT * FROM sessions WHERE user_id = ? AND agent_name = ? ORDER BY created_at ASC LIMIT 1`,
      )
      .get(userId, agentName) as Parameters<typeof this.rowToSession>[0] | undefined;
    if (row) return this.rowToSession(row);
    return this.createSession(userId, agentName);
  }

  // Create a NEW session for a (user, agent). Used by the web channel to start a separate
  // conversation with its own isolated context. `title` is optional (auto-filled from the
  // first message later); the default/"Main" session is created title-less.
  createSession(userId: string, agentName: string, title?: string): PersistedSession {
    this.ensureFreshConnection();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, agent_name, title, created_at, last_active_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(id, userId, agentName, title ?? null, now, now);
    return { id, userId, agentName, title: title ?? null, pinned: false, createdAt: now, lastActiveAt: now };
  }

  // Look up a single session by id (returns null if it doesn't exist). Callers that act on
  // a client-supplied conversation id MUST also check `userId` matches before trusting it —
  // see the web channel's ownership checks.
  getSessionById(sessionId: string): PersistedSession | null {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE id = ?`)
      .get(sessionId) as Parameters<typeof this.rowToSession>[0] | undefined;
    return row ? this.rowToSession(row) : null;
  }

  // All sessions for a (user, agent), most-recently-active first. Powers the web UI's
  // conversation list.
  listSessions(userId: string, agentName: string): PersistedSession[] {
    this.ensureFreshConnection();
    const rows = this.db
      .prepare(
        `SELECT * FROM sessions WHERE user_id = ? AND agent_name = ? ORDER BY last_active_at DESC`,
      )
      .all(userId, agentName) as Array<Parameters<typeof this.rowToSession>[0]>;
    return rows.map((r) => this.rowToSession(r));
  }

  // Number of messages in a session. Used to tell a brand-new, never-used conversation (0)
  // from one that's already been written to — the web "New chat" guardrail reuses an existing
  // empty conversation instead of piling up duplicates.
  countMessages(sessionId: string): number {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM messages WHERE session_id = ?`)
      .get(sessionId) as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  // Set a conversation's title (idempotent overwrite). Used to auto-name a new conversation
  // from its first user message and for an explicit rename later.
  setSessionTitle(sessionId: string, title: string): void {
    this.ensureFreshConnection();
    this.db.prepare(`UPDATE sessions SET title = ? WHERE id = ?`).run(title, sessionId);
  }

  // Pin / unpin a conversation (web sidebar's PINNED section).
  setSessionPinned(sessionId: string, pinned: boolean): void {
    this.ensureFreshConnection();
    this.db.prepare(`UPDATE sessions SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, sessionId);
  }

  // Delete all of a conversation's messages but keep the session row. Used to "delete" the
  // default/"Main" conversation: the row must survive because getOrCreateSession resolves
  // the default as the OLDEST session — dropping it would silently promote another web
  // conversation to be every channel's default. Returns false if the session doesn't exist.
  clearSessionMessages(sessionId: string): boolean {
    this.ensureFreshConnection();
    const existing = this.db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId);
    if (!existing) return false;
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
    return true;
  }

  // Delete a conversation and all of its messages. Returns false if the session doesn't
  // exist. The caller is responsible for ownership checks.
  deleteSession(sessionId: string): boolean {
    this.ensureFreshConnection();
    const existing = this.db.prepare(`SELECT id FROM sessions WHERE id = ?`).get(sessionId);
    if (!existing) return false;
    this.db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
    this.db.prepare(`DELETE FROM sessions WHERE id = ?`).run(sessionId);
    return true;
  }

  appendMessage(args: {
    sessionId: string;
    role: Message["role"];
    content: ContentPart[];
    channel?: string;
    externalMessageId?: string;
  }): PersistedMessage {
    this.ensureFreshConnection();
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO messages (id, session_id, role, channel, external_message_id, content_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        args.sessionId,
        args.role,
        args.channel ?? null,
        args.externalMessageId ?? null,
        JSON.stringify(args.content),
        now,
      );
    this.db.prepare(`UPDATE sessions SET last_active_at = ? WHERE id = ?`).run(now, args.sessionId);
    return {
      id,
      sessionId: args.sessionId,
      role: args.role,
      channel: args.channel ?? null,
      externalMessageId: args.externalMessageId ?? null,
      content: args.content,
      createdAt: now,
    };
  }

  // Messages persisted strictly AFTER `sinceIso` (an ISO-8601 timestamp), in
  // chronological order. Used by the web channel to replay anything an SSE
  // client missed during a reconnect — the browser's Last-Event-ID header
  // carries the createdAt of the last delivered message; this returns the
  // ones it didn't see.
  messagesSince(sessionId: string, sinceIso: string, limit = 200): PersistedMessage[] {
    this.ensureFreshConnection();
    const rows = this.db
      .prepare(
        `SELECT * FROM messages
           WHERE session_id = ? AND created_at > ?
           ORDER BY created_at ASC
           LIMIT ?`,
      )
      .all(sessionId, sinceIso, limit) as Array<{
      id: string;
      session_id: string;
      role: Message["role"];
      channel: string | null;
      external_message_id: string | null;
      content_json: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      channel: r.channel,
      externalMessageId: r.external_message_id,
      content: JSON.parse(r.content_json) as ContentPart[],
      createdAt: r.created_at,
    }));
  }

  // Tail: returns up to `limit` most-recent messages in chronological order.
  tail(sessionId: string, limit = 100): PersistedMessage[] {
    this.ensureFreshConnection();
    const rows = this.db
      .prepare(
        // Order by rowid (insertion order), not created_at: timestamps have millisecond
        // resolution, and a turn persists several rows back-to-back (tool loops, the reply,
        // a compaction marker) within the same millisecond — created_at ties would make
        // their replay order nondeterministic.
        `SELECT * FROM (
           SELECT *, rowid AS rid FROM messages WHERE session_id = ? ORDER BY rowid DESC LIMIT ?
         ) ORDER BY rid ASC`,
      )
      .all(sessionId, limit) as Array<{
      id: string;
      session_id: string;
      role: Message["role"];
      channel: string | null;
      external_message_id: string | null;
      content_json: string;
      created_at: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      channel: r.channel,
      externalMessageId: r.external_message_id,
      content: JSON.parse(r.content_json) as ContentPart[],
      createdAt: r.created_at,
    }));
  }

  // Most-recent inbound channel for a user, used to route agent-initiated outbound.
  lastInboundChannel(userId: string): { channel: string; externalId: string } | null {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(
        `SELECT m.channel as channel, ui.external_id as external_id
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         JOIN user_identities ui ON ui.user_id = s.user_id AND ui.channel = m.channel
         WHERE s.user_id = ? AND m.role = 'user' AND m.channel IS NOT NULL
         ORDER BY m.created_at DESC LIMIT 1`,
      )
      .get(userId) as { channel: string; external_id: string } | undefined;
    if (!row) return null;
    return { channel: row.channel, externalId: row.external_id };
  }

  identitiesFor(userId: string): UserChannelBinding[] {
    this.ensureFreshConnection();
    const rows = this.db
      .prepare(`SELECT user_id, channel, external_id FROM user_identities WHERE user_id = ?`)
      .all(userId) as Array<{ user_id: string; channel: string; external_id: string }>;
    return rows.map((r) => ({ userId: r.user_id, channel: r.channel, externalId: r.external_id }));
  }

  close(): void {
    this.db.close();
  }
}
