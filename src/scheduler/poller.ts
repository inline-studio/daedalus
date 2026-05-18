import type { ArtemisConfig } from "../config/schema.js";
import type { AgentDispatcher } from "../dispatch/base.js";
import type { SessionStore } from "../sessions/store.js";
import type { AttachmentStore } from "../attachments/store.js";
import type { Transcriber } from "../attachments/transcribe.js";
import type { ScheduleStore, ScheduledMessage } from "../sessions/schedule-store.js";
import { ingestIncomingMessage } from "../kernel/ingest.js";
import { nextCronFire } from "./parse-when.js";
import { log } from "../log.js";

// Polls the ScheduleStore for due rows armed by agents at runtime (the
// `schedule_message` tool). Fires each one through the supervisor's dispatcher
// — same path channel messages and static cron schedules take — so docker mode
// gets the same per-message-container treatment.
//
// One-shot rows go pending → firing → done. Recurring rows compute next-fire from
// their cron and go pending → firing → pending (with last_fired_at bumped).
//
// Synthetic ingest identity: channel = "scheduled", external_user_id = the
// scheduled row's `user_external_id` (defaults to the row id, so each schedule
// gets its own persistent session and the agent can see prior fires' history).
export interface PollerDeps {
  store: ScheduleStore;
  sessions: SessionStore;
  attachments: AttachmentStore;
  transcriber: Transcriber;
  dispatcher: AgentDispatcher;
}

export interface PollerHandle {
  stop(): void;
  // Force a tick now (used by tests).
  tick(): Promise<void>;
}

export interface PollerOptions {
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 30_000;

export function startSchedulePoller(
  _config: ArtemisConfig,
  deps: PollerDeps,
  opts: PollerOptions = {},
): PollerHandle {
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return; // skip overlapping ticks; the next interval will retry
    running = true;
    try {
      const due = deps.store.claimDue();
      if (due.length === 0) return;
      log.info({ count: due.length }, "schedule poller: firing due rows");
      for (const row of due) {
        await fireOne(row, deps).catch((err) => {
          log.error({ id: row.id, err }, "schedule fire failed; will retry");
          deps.store.markFailed(row.id);
        });
      }
    } finally {
      running = false;
    }
  };
  const handle = setInterval(() => {
    void tick();
  }, intervalMs);
  // Don't keep Node alive just for the poll loop — the supervisor's bus + cron
  // jobs are the real heartbeat.
  handle.unref?.();
  log.info({ intervalMs }, "schedule poller armed");
  return {
    stop: () => clearInterval(handle),
    tick,
  };
}

async function fireOne(row: ScheduledMessage, deps: PollerDeps): Promise<void> {
  const ingested = await ingestIncomingMessage({
    agentName: row.agentName,
    incoming: {
      channel: "scheduled",
      externalUserId: row.userExternalId,
      text: row.prompt,
      attachments: [],
      receivedAt: new Date().toISOString(),
    },
    sessions: deps.sessions,
    attachments: deps.attachments,
    transcriber: deps.transcriber,
  });
  const result = await deps.dispatcher.dispatch({
    agentName: row.agentName,
    sessionId: ingested.sessionId,
    userId: ingested.userId,
    isSubagent: false,
  });
  if (row.recurringCron) {
    const next = nextCronFire(row.recurringCron);
    deps.store.reschedule(row.id, next);
    log.info(
      { id: row.id, agent: row.agentName, status: result.status, nextDueAt: next },
      "scheduled message fired (recurring; re-armed)",
    );
  } else {
    deps.store.markFired(row.id);
    log.info(
      { id: row.id, agent: row.agentName, status: result.status },
      "scheduled message fired (one-shot; done)",
    );
  }
}
