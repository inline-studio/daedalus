import fs from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import YAML from "yaml";
import { z } from "zod";
import { log } from "../log.js";
import type { ArtemisConfig } from "../config/schema.js";
import { ingestIncomingMessage } from "../kernel/ingest.js";
import { buildDispatcher } from "../dispatch/factory.js";
import type { AgentDispatcher, DispatchResult } from "../dispatch/base.js";
import type { MessageBus } from "../channels/bus.js";
import type { OutgoingMessage, OutgoingAttachment } from "../channels/base.js";
import type { SessionStore } from "../sessions/store.js";
import type { AttachmentStore } from "../attachments/store.js";
import type { Transcriber } from "../attachments/transcribe.js";
import { NoopTranscriber } from "../attachments/transcribe.js";

// brain/schedules/<name>.yaml
const ScheduleSchema = z.object({
  name: z.string(),
  agent: z.string(),
  schedule: z.string(), // cron expression
  prompt: z.string(),
  enabled: z.boolean().default(true),
  // IMP-10: optionally deliver the agent's reply to a real channel/user (e.g. "DM me the
  // result"). Omit for a pure background job (the reply is just logged). Requires the message
  // bus, so it only delivers under `dae serve`, not the bare `dae schedule` foreground runner.
  deliverTo: z
    .object({ channel: z.string(), externalUserId: z.coerce.string() })
    .optional(),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export interface RunningSchedule {
  schedule: Schedule;
  job: Cron;
}

export async function loadSchedules(brainPath: string): Promise<Schedule[]> {
  const dir = path.join(brainPath, "schedules");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return [];
  }
  const out: Schedule[] = [];
  for (const f of files) {
    const text = await fs.readFile(path.join(dir, f), "utf8");
    try {
      out.push(ScheduleSchema.parse(YAML.parse(text)));
    } catch (err) {
      log.error({ file: f, err }, "invalid schedule");
    }
  }
  return out;
}

export interface SchedulerDeps {
  sessions: SessionStore;
  attachments: AttachmentStore;
  transcriber: Transcriber;
  // Optional; built from config if not supplied (the serve loop passes its own
  // so we don't construct duplicates).
  dispatcher?: AgentDispatcher;
  // IMP-10: the channel bus, so a schedule with `deliverTo` can push its reply to a real user.
  // Absent under `dae schedule` (no channels running) — deliverTo is then a no-op (logged).
  bus?: MessageBus;
}

// Fire each cron trigger through the AgentDispatcher so docker-mode setups run
// the scheduled agent in a fresh per-message container (with the agent's own
// image, OneCLI identity, brain mount, …) — same path that channel inbounds take.
//
// Each schedule gets a stable synthetic identity ("schedule"/<schedule-name>) so
// repeated fires accrete into a single per-schedule session — handy for an
// "every 10 minutes" agent that needs to remember prior runs.
export function startScheduler(
  config: ArtemisConfig,
  schedules: Schedule[],
  deps: SchedulerDeps,
): RunningSchedule[] {
  const dispatcher = deps.dispatcher ?? buildDispatcher(config);
  const running: RunningSchedule[] = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    const job = new Cron(s.schedule, async () => {
      try {
        const ingested = await ingestIncomingMessage({
          agentName: s.agent,
          incoming: {
            channel: "schedule",
            externalUserId: s.name,
            text: s.prompt,
            attachments: [],
            receivedAt: new Date().toISOString(),
          },
          sessions: deps.sessions,
          attachments: deps.attachments,
          transcriber: deps.transcriber,
        });
        const r = await dispatcher.dispatch({
          agentName: s.agent,
          sessionId: ingested.sessionId,
          userId: ingested.userId,
          isSubagent: false,
          // Match the synthetic ingest identity so an in-turn schedule_message
          // re-arms against this schedule's own session.
          originChannel: "schedule",
          originExternalUserId: s.name,
        });
        log.info(
          { schedule: s.name, agent: s.agent, turns: r.turns, status: r.status },
          "scheduled run complete",
        );
        // IMP-10: if the schedule names a delivery target, push the reply to that channel/user.
        if (s.deliverTo) {
          if (deps.bus) await deliverScheduledReply(deps.bus, deps.attachments, s.deliverTo, r);
          else
            log.warn(
              { schedule: s.name },
              "schedule has deliverTo but no message bus (not running under `dae serve`) — reply not delivered",
            );
        }
      } catch (err) {
        log.error({ schedule: s.name, err }, "scheduled run failed");
      }
    });
    running.push({ schedule: s, job });
    log.info({ name: s.name, expr: s.schedule, agent: s.agent }, "schedule armed");
  }
  return running;
}

// IMP-10: deliver a static schedule's reply to its configured channel/user. Sends the agent's
// final text (or pending question) plus any reply attachments resolved from the shared store.
async function deliverScheduledReply(
  bus: MessageBus,
  attachments: AttachmentStore,
  target: { channel: string; externalUserId: string },
  result: DispatchResult,
): Promise<void> {
  const ch = bus.channelFor(target.channel);
  if (!ch) {
    log.warn({ channel: target.channel }, "schedule deliverTo: channel not enabled — reply not delivered");
    return;
  }
  const text = result.status === "pending_question" ? result.question : result.finalText;
  const outgoing: OutgoingMessage = { text };
  if (result.status === "complete" && result.attachments?.length) {
    const resolved: OutgoingAttachment[] = [];
    for (const a of result.attachments) {
      const data = await attachments.readBuffer(a.ref);
      if (!data) continue;
      resolved.push({
        data,
        mediaType: a.mediaType,
        ...(a.filename ? { filename: a.filename } : {}),
        ...(a.caption ? { caption: a.caption } : {}),
      });
    }
    if (resolved.length) outgoing.attachments = resolved;
  }
  await ch
    .send(target.externalUserId, outgoing)
    .catch((err) => log.warn({ channel: target.channel, err }, "schedule deliverTo: send failed"));
}

// Convenience for callers (currently `dae schedule`) that don't already have a
// SessionStore + AttachmentStore in hand. Returns a NoopTranscriber — scheduled
// prompts shouldn't carry audio attachments anyway.
export function defaultSchedulerDeps(sessions: SessionStore, attachments: AttachmentStore): SchedulerDeps {
  return { sessions, attachments, transcriber: new NoopTranscriber() };
}
