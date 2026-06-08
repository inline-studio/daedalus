import type { ArtemisConfig } from "../config/schema.js";
import type { AgentDispatcher, DispatchResult } from "../dispatch/base.js";
import type { SessionStore } from "../sessions/store.js";
import type { AttachmentStore } from "../attachments/store.js";
import type { Transcriber } from "../attachments/transcribe.js";
import type { ScheduleStore, ScheduledMessage } from "../sessions/schedule-store.js";
import type { MessageBus } from "../channels/bus.js";
import type { OutgoingMessage, OutgoingAttachment } from "../channels/base.js";
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
// Ingest identity: the fire is ingested on the SAME channel + external_user_id the
// user armed the schedule on (stored on the row). That resolves to the user's real
// session so the reminder lands back in the channel they spoke on — not an orphan
// "scheduled" user. The same identity is passed as the turn's origin so a reminder
// that arms a follow-up schedule keeps routing to the real user.
export interface PollerDeps {
  store: ScheduleStore;
  sessions: SessionStore;
  attachments: AttachmentStore;
  transcriber: Transcriber;
  dispatcher: AgentDispatcher;
  // Delivers the fired turn's reply back to the originating channel. Without it a
  // dispatched reminder would run but never reach the user (the dispatcher only
  // produces the reply text; sending is the caller's job — same as the channel
  // inbound path in serve.ts).
  bus: MessageBus;
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

// The fired prompt is ingested as a user-style turn (same path a channel message
// takes). Without framing, the agent can't tell a scheduler-replayed string from
// the user typing it right now — so a stored reminder like "remind me to log
// expenses" reads as a *fresh* scheduling request, and the agent checks its
// schedules, sees this very row mid-fire, and asks "reschedule or leave?" instead
// of delivering anything. This marker tells the agent the turn is a timer it armed
// firing now: act on the intent (deliver a reminder, or carry out a self-task) and
// never re-arm or ask about rescheduling it. Kept deliberately use-case-neutral so
// it works for both user reminders and self-directed status pings.
export function frameFiredPrompt(prompt: string): string {
  return (
    `[SCHEDULED MESSAGE — a timer you armed earlier is firing now. This is NOT a new ` +
    `request from the user. Act on the intent below: if it's a reminder, deliver it to ` +
    `the user in your own words; if it's a task to check on, carry it out now. This timer ` +
    `is already being handled — do NOT re-arm it, schedule a new one, or ask the user ` +
    `whether to reschedule.]\n\n${prompt}`
  );
}

async function fireOne(row: ScheduledMessage, deps: PollerDeps): Promise<void> {
  log.info(
    { id: row.id, agent: row.agentName, channel: row.channel, externalUserId: row.userExternalId },
    "schedule poller: firing — resolving origin identity",
  );
  const ingested = await ingestIncomingMessage({
    agentName: row.agentName,
    incoming: {
      channel: row.channel,
      externalUserId: row.userExternalId,
      text: frameFiredPrompt(row.prompt),
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
    // Carry the same identity as origin so a reminder that arms a follow-up
    // schedule re-targets the real user, not a synthetic session.
    originChannel: row.channel,
    originExternalUserId: row.userExternalId,
  });

  // Deliver the reply back to the channel the user armed the schedule on. The
  // dispatcher only produces the reply; sending is on us (mirrors serve.ts's
  // inbound path). Force the row's channel so it lands where the user expects
  // even if they've since spoken elsewhere.
  await deliverReply(row, ingested.sessionId, ingested.userId, result, deps);

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

// Push the fired turn's reply to the user over the channel they armed it on.
// Mirrors serve.ts's inbound delivery (notices, then the reply, with any reply
// attachments resolved from the shared store) but routes by stored channel
// identity instead of a live inbound message.
async function deliverReply(
  row: ScheduledMessage,
  sessionId: string,
  userId: string,
  result: DispatchResult,
  deps: PollerDeps,
): Promise<void> {
  const send = (msg: OutgoingMessage) =>
    deps.bus
      .sendToUser(userId, { ...msg, conversationId: sessionId }, { forceChannel: row.channel })
      .catch((err) => log.warn({ id: row.id, err }, "scheduled reply delivery failed"));

  if (result.notices?.length) {
    for (const n of result.notices) await send({ text: n });
  }

  const reply = result.status === "pending_question" ? result.question : result.finalText;

  const outgoing: OutgoingMessage = { text: reply };
  if (result.status === "complete" && result.attachments?.length) {
    const resolved: OutgoingAttachment[] = [];
    for (const a of result.attachments) {
      const data = await deps.attachments.readBuffer(a.ref);
      if (!data) {
        log.warn({ id: row.id, ref: a.ref }, "scheduled reply attachment ref not found — skipping");
        continue;
      }
      resolved.push({
        data,
        mediaType: a.mediaType,
        ...(a.filename ? { filename: a.filename } : {}),
        ...(a.caption ? { caption: a.caption } : {}),
      });
    }
    if (resolved.length) outgoing.attachments = resolved;
  }
  await send(outgoing);
}
