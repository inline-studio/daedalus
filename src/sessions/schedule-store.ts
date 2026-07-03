import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

// Persistent store for *agent-issued* schedules — runtime callbacks an agent can
// arm via the schedule_message tool ("remind me in 30 minutes", "ping me every
// 10 minutes with progress"). Distinct from brain/schedules/*.yaml which is
// statically configured cron at startup.
//
// Schema lives in the same sqlite file as sessions for simplicity; a separate
// table keeps the concerns clean.
//
// Status lifecycle:
//   pending → firing → done            (one-shot)
//   pending → firing → pending → …     (recurring; reset to pending after each fire)
//   * → cancelled                      (terminal; not deleted so the agent can
//                                        list past-cancelled if it wants)
//
// `due_at` is the next-fire ISO timestamp. For one-shot it doesn't move; for
// recurring we compute the next occurrence from `recurring_cron` after each fire.
export type ScheduleStatus = "pending" | "firing" | "done" | "cancelled";

export interface ScheduledMessage {
  id: string;
  // The agent that should run when this fires. Usually the same agent that
  // armed it ("artemis arms a self-callback"), but could be any agent.
  agentName: string;
  // The agent identity that *created* this row. Used to scope `cancel` / `list`
  // so an agent can only cancel its own schedules — prevents one subagent
  // accidentally killing another's callbacks.
  createdByAgent: string;
  // The channel of the user who armed this schedule (e.g. "telegram", "web").
  // The poller ingests the fire on this channel so the reply routes back to the
  // real user instead of an orphan "scheduled" session.
  channel: string;
  // The external_user_id of the user who armed this schedule (e.g. the Telegram
  // numeric id). Paired with `channel`, it resolves to the originating user at
  // fire time so the reminder lands in their real session.
  userExternalId: string;
  // The prompt text to feed the agent when this fires.
  prompt: string;
  // ISO timestamp when this should next fire.
  dueAt: string;
  // If non-null, after firing the row is re-enqueued with the next cron
  // occurrence. If null, the row becomes `done` after firing.
  recurringCron: string | null;
  status: ScheduleStatus;
  createdAt: string;
  // Most recent fire timestamp (null until first fire).
  lastFiredAt: string | null;
  // Number of successful fires so far.
  fireCount: number;
  // BUG-04: consecutive failed-fire attempts since the last success — drives backoff + dead-letter.
  fireAttempts: number;
}

// BUG-04: outcome of markFailed, so the poller can log a retry vs a dead-letter accurately.
export interface FireFailureOutcome {
  attempts: number;
  deadLettered: boolean;
  nextDueAt?: string;
}

// BUG-04: dead-letter a schedule after this many consecutive failed fires (prevents a poison
// row from re-firing every poll tick forever).
const MAX_FIRE_ATTEMPTS = 5;

export interface EnqueueArgs {
  agentName: string;
  createdByAgent: string;
  // Origin identity of the user arming the schedule. Required (no fallback) so a
  // fired schedule always routes back to the real user — see the orphan-session
  // bug this guards against.
  channel: string;
  userExternalId: string;
  prompt: string;
  dueAt: string;
  recurringCron?: string | null;
}

export class ScheduleStore {
  private db!: DatabaseSync;
  private readonly dbPath: string;
  // See SessionStore.openConnection() for the rationale. Same problem (file
  // gets replaced under us by a reinstall / upgrade); same defensive fstat +
  // reopen at the top of every public method.
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
      CREATE TABLE IF NOT EXISTS scheduled_messages (
        id TEXT PRIMARY KEY,
        agent_name TEXT NOT NULL,
        created_by_agent TEXT NOT NULL,
        channel TEXT NOT NULL DEFAULT 'scheduled',
        user_external_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        due_at TEXT NOT NULL,
        recurring_cron TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending','firing','done','cancelled')),
        created_at TEXT NOT NULL,
        last_fired_at TEXT,
        fire_count INTEGER NOT NULL DEFAULT 0,
        fire_attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_due
        ON scheduled_messages(status, due_at);
      CREATE INDEX IF NOT EXISTS idx_scheduled_messages_creator
        ON scheduled_messages(created_by_agent, status);
    `);
    // Legacy tables predate the `channel` column. Add it with a default so the
    // NOT NULL stays satisfiable; any pre-existing rows were already misrouting
    // (the orphan-session bug) so 'scheduled' is a fine backfill — they can't be
    // delivered correctly retroactively anyway.
    const cols = this.db
      .prepare(`PRAGMA table_info(scheduled_messages)`)
      .all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "channel")) {
      this.db.exec(
        `ALTER TABLE scheduled_messages ADD COLUMN channel TEXT NOT NULL DEFAULT 'scheduled'`,
      );
    }
    // BUG-04: legacy tables predate fire_attempts (the failure backoff / dead-letter counter).
    if (!cols.some((c) => c.name === "fire_attempts")) {
      this.db.exec(
        `ALTER TABLE scheduled_messages ADD COLUMN fire_attempts INTEGER NOT NULL DEFAULT 0`,
      );
    }
  }

  enqueue(args: EnqueueArgs): ScheduledMessage {
    this.ensureFreshConnection();
    const id = `sched_${crypto.randomBytes(8).toString("hex")}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO scheduled_messages
           (id, agent_name, created_by_agent, channel, user_external_id, prompt, due_at,
            recurring_cron, status, created_at, last_fired_at, fire_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL, 0)`,
      )
      .run(
        id,
        args.agentName,
        args.createdByAgent,
        args.channel,
        args.userExternalId,
        args.prompt,
        args.dueAt,
        args.recurringCron ?? null,
        now,
      );
    return this.get(id)!;
  }

  get(id: string): ScheduledMessage | null {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(`SELECT * FROM scheduled_messages WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return rowToScheduledMessage(row);
  }

  // Rows that are due (status=pending AND due_at <= now). Atomically flip them
  // to 'firing' so a concurrent poll tick (if there ever is one) doesn't fire
  // them twice. Caller is responsible for calling markFired / reschedule /
  // markFailed after running each one.
  claimDue(asOf = new Date()): ScheduledMessage[] {
    this.ensureFreshConnection();
    const iso = asOf.toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_messages
         WHERE status = 'pending' AND due_at <= ?
         ORDER BY due_at ASC`,
      )
      .all(iso) as Record<string, unknown>[];
    const out: ScheduledMessage[] = [];
    for (const row of rows) {
      const id = row.id as string;
      const r = this.db
        .prepare(
          `UPDATE scheduled_messages
           SET status = 'firing'
           WHERE id = ? AND status = 'pending'`,
        )
        .run(id);
      // BUG-08: the SELECTed `row` still says status='pending'; reflect the just-applied
      // 'firing' transition on the returned object so consumers don't see a stale status.
      if (r.changes > 0) out.push({ ...rowToScheduledMessage(row), status: "firing" });
    }
    return out;
  }

  // After a successful fire of a one-shot row.
  markFired(id: string, firedAt = new Date()): void {
    this.ensureFreshConnection();
    this.db
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'done',
             last_fired_at = ?,
             fire_count = fire_count + 1,
             fire_attempts = 0
         WHERE id = ?`,
      )
      .run(firedAt.toISOString(), id);
  }

  // After a successful fire of a recurring row — re-arm with the supplied next-fire time.
  reschedule(id: string, nextDueAt: string, firedAt = new Date()): void {
    this.ensureFreshConnection();
    this.db
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'pending',
             due_at = ?,
             last_fired_at = ?,
             fire_count = fire_count + 1,
             fire_attempts = 0
         WHERE id = ?`,
      )
      .run(nextDueAt, firedAt.toISOString(), id);
  }

  // BUG-04: a failed fire used to return straight to 'pending' with the same due_at, so a
  // poison row re-fired every poll tick (30s) forever. Now we count the attempt, back off
  // (push due_at forward, exponentially), and after MAX_FIRE_ATTEMPTS dead-letter the row so it
  // stops being claimed. A success (markFired / reschedule) resets fire_attempts. Dead-lettering
  // reuses the terminal 'cancelled' status to avoid a CHECK-constraint table rebuild; the
  // poller's log + fire_attempts distinguish it from a user cancellation.
  markFailed(id: string, failedAt = new Date()): FireFailureOutcome {
    this.ensureFreshConnection();
    const row = this.get(id);
    if (!row || row.status !== "firing") {
      return { attempts: row?.fireAttempts ?? 0, deadLettered: false };
    }
    const attempts = row.fireAttempts + 1;
    if (attempts >= MAX_FIRE_ATTEMPTS) {
      this.db
        .prepare(
          `UPDATE scheduled_messages SET status = 'cancelled', fire_attempts = ? WHERE id = ? AND status = 'firing'`,
        )
        .run(attempts, id);
      return { attempts, deadLettered: true };
    }
    // Exponential backoff: 2, 4, 8, 16 min … capped at 1h.
    const backoffMs = Math.min(2 ** attempts * 60_000, 60 * 60_000);
    const nextDueAt = new Date(failedAt.getTime() + backoffMs).toISOString();
    this.db
      .prepare(
        `UPDATE scheduled_messages SET status = 'pending', due_at = ?, fire_attempts = ? WHERE id = ? AND status = 'firing'`,
      )
      .run(nextDueAt, attempts, id);
    return { attempts, deadLettered: false, nextDueAt };
  }

  cancel(id: string, byAgent: string): boolean {
    this.ensureFreshConnection();
    const r = this.db
      .prepare(
        `UPDATE scheduled_messages
         SET status = 'cancelled'
         WHERE id = ? AND created_by_agent = ? AND status IN ('pending','firing')`,
      )
      .run(id, byAgent);
    return r.changes > 0;
  }

  // List pending schedules created by a given agent. Deliberately excludes
  // 'firing' rows: a row is only in 'firing' state for the duration of its own
  // fired turn, so the only schedule a fired turn would ever see as 'firing' is
  // *itself* mid-fire. Surfacing that made the agent treat the in-flight reminder
  // as a pre-existing schedule and ask "reschedule or leave?" instead of just
  // delivering it. Pending-only gives the agent the set of genuinely upcoming
  // schedules without the self-collision.
  // All armed (pending/firing) runtime schedules — the web UI's cron viewer. Read-only,
  // any creator (unlike listForAgent, which is scoped for the cancel tool's authz).
  listActive(): ScheduledMessage[] {
    this.ensureFreshConnection();
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_messages WHERE status IN ('pending','firing') ORDER BY due_at ASC`,
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map(rowToScheduledMessage);
  }

  // Number of armed (pending/firing) runtime schedules — the web status bar's "cron" count.
  countActive(): number {
    this.ensureFreshConnection();
    const row = this.db
      .prepare(`SELECT COUNT(*) AS n FROM scheduled_messages WHERE status IN ('pending','firing')`)
      .get() as { n: number } | undefined;
    return row ? Number(row.n) : 0;
  }

  listForAgent(byAgent: string): ScheduledMessage[] {
    this.ensureFreshConnection();
    const rows = this.db
      .prepare(
        `SELECT * FROM scheduled_messages
         WHERE created_by_agent = ? AND status = 'pending'
         ORDER BY due_at ASC`,
      )
      .all(byAgent) as Record<string, unknown>[];
    return rows.map(rowToScheduledMessage);
  }

  close(): void {
    this.db.close();
  }
}

function rowToScheduledMessage(row: Record<string, unknown>): ScheduledMessage {
  return {
    id: row.id as string,
    agentName: row.agent_name as string,
    createdByAgent: row.created_by_agent as string,
    channel: row.channel as string,
    userExternalId: row.user_external_id as string,
    prompt: row.prompt as string,
    dueAt: row.due_at as string,
    recurringCron: (row.recurring_cron as string | null) ?? null,
    status: row.status as ScheduleStatus,
    createdAt: row.created_at as string,
    lastFiredAt: (row.last_fired_at as string | null) ?? null,
    fireCount: row.fire_count as number,
    fireAttempts: (row.fire_attempts as number | null) ?? 0,
  };
}
