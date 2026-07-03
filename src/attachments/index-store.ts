import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Persistent catalogue of attachments a user has ever uploaded, so the assistant can
// re-reference a file in a later session — or after it scrolled out of context — without
// the user re-uploading it. The bytes already persist forever in the content-addressable
// AttachmentStore (on the /data volume); this table is the *discoverability* layer that
// the AttachmentStore lacks — it only ever sees a ref the inbound message happened to carry.
//
// Recall is scoped per USER (daedalus resolves one user across every channel), so a PDF
// dropped in Telegram is findable from the web UI. Provenance (`session_id`) is recorded
// but not used to scope search.
//
// Schema lives in the same sqlite file as sessions for simplicity; a separate table keeps
// the concerns clean (mirrors ScheduleStore). The `ref` is the same "sha256:<hex>" key the
// agent passes to the read_attachment tool to pull the bytes back.
export interface IndexedAttachment {
  ref: string;
  userId: string;
  filename: string | null;
  mediaType: string;
  bytes: number;
  // One-line description of the contents, so search matches meaning, not just the filename.
  // Null until something fills it (the agent may set it opportunistically when it reads the
  // file); search still returns null-summary rows so a fresh upload is findable immediately.
  summary: string | null;
  uploadedAt: string;
  // The session the file was uploaded in. Provenance only — recall is per-user.
  sessionId: string | null;
}

export interface RecordArgs {
  ref: string;
  userId: string;
  filename?: string | null;
  mediaType: string;
  bytes: number;
  sessionId?: string | null;
}

export class AttachmentIndexStore {
  private db!: DatabaseSync;
  private readonly dbPath: string;
  // See SessionStore.openConnection() for the rationale. Same problem (the file gets
  // replaced under us by a reinstall / upgrade); same defensive fstat + reopen at the top
  // of every public method.
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
        /* old fd may be invalid; ignore */
      }
    }
    this.db = new DatabaseSync(this.dbPath);
    this.migrate();
    try {
      const st = fs.statSync(this.dbPath);
      this.openedInode = Number(st.ino);
      this.openedDev = Number(st.dev);
    } catch {
      this.openedInode = 0;
      this.openedDev = 0;
    }
  }

  private ensureFreshConnection(): void {
    let inode = 0;
    let dev = 0;
    try {
      const st = fs.statSync(this.dbPath);
      inode = Number(st.ino);
      dev = Number(st.dev);
    } catch {
      this.openConnection();
      return;
    }
    if (inode !== this.openedInode || dev !== this.openedDev) {
      this.openConnection();
    }
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS attachment_index (
        user_id TEXT NOT NULL,
        ref TEXT NOT NULL,
        filename TEXT,
        media_type TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        summary TEXT,
        uploaded_at TEXT NOT NULL,
        session_id TEXT,
        PRIMARY KEY (user_id, ref)
      );
      CREATE INDEX IF NOT EXISTS idx_attachment_index_user_uploaded
        ON attachment_index(user_id, uploaded_at DESC);
    `);
  }

  // Record an upload. Idempotent per (user, ref): re-uploading the same bytes refreshes the
  // filename + uploaded_at (so it floats to the top of `recent`) but preserves an existing
  // summary — a value the agent took an LLM call to write shouldn't be wiped by a re-send.
  record(args: RecordArgs): void {
    this.ensureFreshConnection();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO attachment_index
           (user_id, ref, filename, media_type, bytes, summary, uploaded_at, session_id)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)
         ON CONFLICT(user_id, ref) DO UPDATE SET
           filename = excluded.filename,
           media_type = excluded.media_type,
           bytes = excluded.bytes,
           uploaded_at = excluded.uploaded_at,
           session_id = excluded.session_id`,
      )
      .run(
        args.userId,
        args.ref,
        args.filename ?? null,
        args.mediaType,
        args.bytes,
        now,
        args.sessionId ?? null,
      );
  }

  // Attach/replace a one-line content summary for a file the user owns. No-op if the
  // (user, ref) pair isn't indexed (e.g. it was never uploaded by this user).
  setSummary(userId: string, ref: string, summary: string): void {
    this.ensureFreshConnection();
    this.db
      .prepare(`UPDATE attachment_index SET summary = ? WHERE user_id = ? AND ref = ?`)
      .run(summary, userId, ref);
  }

  // Substring search over filename + summary for one user, newest first. An empty/blank
  // query degrades to `recent` so "what have I uploaded?" works without a search term.
  search(userId: string, query: string, limit = 20): IndexedAttachment[] {
    this.ensureFreshConnection();
    const q = query.trim();
    if (!q) return this.recent(userId, limit);
    // Escape LIKE wildcards in the user's query so a literal % / _ doesn't match everything.
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM attachment_index
         WHERE user_id = ?
           AND (filename LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\')
         ORDER BY uploaded_at DESC
         LIMIT ?`,
      )
      .all(userId, like, like, limit) as Record<string, unknown>[];
    return rows.map(rowToIndexed);
  }

  recent(userId: string, limit = 20): IndexedAttachment[] {
    this.ensureFreshConnection();
    const rows = this.db
      .prepare(
        `SELECT * FROM attachment_index
         WHERE user_id = ?
         ORDER BY uploaded_at DESC
         LIMIT ?`,
      )
      .all(userId, limit) as Record<string, unknown>[];
    return rows.map(rowToIndexed);
  }

  // Ownership lookup for the artifacts download route: the row only comes back when this
  // ref was recorded for THIS user, so one user can't fetch another's files by ref.
  getByRef(userId: string, ref: string): IndexedAttachment | null {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(`SELECT * FROM attachment_index WHERE user_id = ? AND ref = ? LIMIT 1`)
      .get(userId, ref) as Record<string, unknown> | undefined;
    return row ? rowToIndexed(row) : null;
  }

  close(): void {
    this.db.close();
  }
}

function rowToIndexed(row: Record<string, unknown>): IndexedAttachment {
  return {
    ref: row.ref as string,
    userId: row.user_id as string,
    filename: (row.filename as string | null) ?? null,
    mediaType: row.media_type as string,
    bytes: row.bytes as number,
    summary: (row.summary as string | null) ?? null,
    uploadedAt: row.uploaded_at as string,
    sessionId: (row.session_id as string | null) ?? null,
  };
}
