import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// Persistence for skill self-learning (see docs/skills.md → "Self-learning"):
//
//   skill_usage — one row per skill, bumped every load_skill call. The staleness curator
//   reads this to age out agent-created skills nobody uses; "never in the table" means
//   "never used since learning was enabled", which the curator treats as unused.
//
//   skill_nudge — per-session count of tool calls since the last skill_manage use. The
//   cross-turn backstop that arms a review pass even when every individual turn stays
//   below the minToolCalls trigger. Reset whenever skill_manage actually runs.
//
// Same sqlite file as sessions (one mounted volume, one file to back up); separate tables
// keep the concerns clean — the ScheduleStore precedent.

export interface SkillUsageRow {
  skill: string;
  lastUsedAt: string;
  uses: number;
}

export class SkillLearningStore {
  private db!: DatabaseSync;
  private readonly dbPath: string;
  // See SessionStore.openConnection() for the rationale. Same problem (file gets
  // replaced under us by a reinstall / upgrade); same defensive fstat + reopen.
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
      CREATE TABLE IF NOT EXISTS skill_usage (
        skill TEXT PRIMARY KEY,
        last_used_at TEXT NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS skill_nudge (
        session_id TEXT PRIMARY KEY,
        tool_calls INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  recordUse(skill: string): void {
    this.ensureFreshConnection();
    this.db
      .prepare(
        `INSERT INTO skill_usage (skill, last_used_at, uses) VALUES (?, ?, 1)
         ON CONFLICT(skill) DO UPDATE SET last_used_at = excluded.last_used_at, uses = uses + 1`,
      )
      .run(skill, new Date().toISOString());
  }

  lastUsed(skill: string): string | null {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(`SELECT last_used_at FROM skill_usage WHERE skill = ?`)
      .get(skill) as { last_used_at: string } | undefined;
    return row?.last_used_at ?? null;
  }

  allUsage(): SkillUsageRow[] {
    this.ensureFreshConnection();
    const rows = this.db
      .prepare(`SELECT skill, last_used_at, uses FROM skill_usage`)
      .all() as Array<{ skill: string; last_used_at: string; uses: number }>;
    return rows.map((r) => ({ skill: r.skill, lastUsedAt: r.last_used_at, uses: r.uses }));
  }

  // Accumulate this turn's tool calls into the session's nudge counter; returns the new total.
  addToolCalls(sessionId: string, count: number): number {
    this.ensureFreshConnection();
    this.db
      .prepare(
        `INSERT INTO skill_nudge (session_id, tool_calls) VALUES (?, ?)
         ON CONFLICT(session_id) DO UPDATE SET tool_calls = tool_calls + excluded.tool_calls`,
      )
      .run(sessionId, count);
    const row = this.db
      .prepare(`SELECT tool_calls FROM skill_nudge WHERE session_id = ?`)
      .get(sessionId) as { tool_calls: number } | undefined;
    return row?.tool_calls ?? 0;
  }

  resetNudge(sessionId: string): void {
    this.ensureFreshConnection();
    this.db.prepare(`DELETE FROM skill_nudge WHERE session_id = ?`).run(sessionId);
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}
