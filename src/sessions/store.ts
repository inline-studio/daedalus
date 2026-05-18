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
    this.db = new DatabaseSync(this.dbPath);
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
        created_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL,
        UNIQUE (user_id, agent_name)
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
    `);
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

  // Get-or-create the (user, agent) session.
  getOrCreateSession(userId: string, agentName: string): PersistedSession {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(`SELECT * FROM sessions WHERE user_id = ? AND agent_name = ?`)
      .get(userId, agentName) as
      | { id: string; user_id: string; agent_name: string; created_at: string; last_active_at: string }
      | undefined;
    if (row) {
      return {
        id: row.id,
        userId: row.user_id,
        agentName: row.agent_name,
        createdAt: row.created_at,
        lastActiveAt: row.last_active_at,
      };
    }
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, user_id, agent_name, created_at, last_active_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(id, userId, agentName, now, now);
    return { id, userId, agentName, createdAt: now, lastActiveAt: now };
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

  // Tail: returns up to `limit` most-recent messages in chronological order.
  tail(sessionId: string, limit = 100): PersistedMessage[] {
    this.ensureFreshConnection();
    const rows = this.db
      .prepare(
        `SELECT * FROM (
           SELECT * FROM messages WHERE session_id = ? ORDER BY created_at DESC LIMIT ?
         ) ORDER BY created_at ASC`,
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
