import type { ArtemisConfig } from "./config/schema.js";
import { applyOneCli } from "./secrets/onecli.js";
import { SessionStore } from "./sessions/store.js";
import { ScheduleStore } from "./sessions/schedule-store.js";
import { AttachmentStore } from "./attachments/store.js";
import { NoopTranscriber, OpenAITranscriber, type Transcriber } from "./attachments/transcribe.js";
import { MessageBus } from "./channels/bus.js";
import { buildChannels } from "./channels/registry.js";
import type { OutgoingMessage, OutgoingAttachment } from "./channels/base.js";
import { ingestIncomingMessage } from "./kernel/ingest.js";
import { buildDispatcher } from "./dispatch/factory.js";
import { PersistentContainerDispatcher } from "./dispatch/persistent.js";
import type { AgentDispatcher } from "./dispatch/base.js";
import { loadSchedules, startScheduler } from "./scheduler/cron.js";
import { startSchedulePoller } from "./scheduler/poller.js";
import { log } from "./log.js";

// Long-running supervisor. Per inbound message:
//   1. Ingest (attachments, transcripts, persist user message) — supervisor IO
//   2. Dispatch the agent turn — either in-process (host mode) or in a fresh
//      container (docker mode). The dispatcher abstraction hides the difference
//      from the rest of the supervisor.
//   3. Send the response back via the channel the message arrived on.
//
// In docker mode the dispatcher spawns a container that mounts the same session
// sqlite + attachments dir + brain that the supervisor has, so the agent reads
// its history from disk and writes the response back to the same DB.
export async function serve(config: ArtemisConfig): Promise<void> {
  await applyOneCli(config.onecli);

  const sessions = new SessionStore(config.sessions.dbPath);
  const scheduleStore = new ScheduleStore(config.sessions.dbPath);
  const attachments = new AttachmentStore(config.sessions.attachmentsPath);
  await attachments.ensureDir();
  const transcriber = buildTranscriber(config);

  const channels = buildChannels(config.channels);
  if (channels.length === 0) {
    log.error(
      "No channels enabled in config.channels — nothing to listen on. Enable at least one (cli/web/telegram/whatsapp).",
    );
    return;
  }

  // With persistentAgent, top-level turns go to the long-lived warm worker over HTTP
  // (subagents inside it still spawn ephemeral containers). Otherwise the supervisor
  // dispatches each turn itself per the configured dispatcher.
  const dispatcher: AgentDispatcher = config.runtime.persistentAgent
    ? new PersistentContainerDispatcher(config)
    : buildDispatcher(config);
  log.info({ dispatcher: dispatcher.id }, "supervisor dispatcher selected");

  const bus = new MessageBus(sessions);
  for (const ch of channels) bus.register(ch);

  bus.onIncoming(async (msg) => {
    const ch = bus.channelFor(msg.channel);
    if (!ch) return;
    const agentName = msg.addressedTo ?? ch.defaultAgent;
    try {
      const ingested = await ingestIncomingMessage({
        agentName,
        incoming: msg,
        sessions,
        attachments,
        transcriber,
        config,
      });
      const result = await dispatcher.dispatch({
        agentName,
        sessionId: ingested.sessionId,
        userId: ingested.userId,
        isSubagent: false,
      });
      const reply =
        result.status === "pending_question" ? result.question : result.finalText;
      const outgoing: OutgoingMessage = { text: reply };
      // Resolve any reply attachments (refs into the shared AttachmentStore) to bytes so
      // the channel can upload them. The agent stored them on the same /data volume.
      if (result.status === "complete" && result.attachments?.length) {
        const resolved: OutgoingAttachment[] = [];
        for (const a of result.attachments) {
          const data = await attachments.readBuffer(a.ref);
          if (!data) {
            log.warn({ ref: a.ref }, "reply attachment ref not found — skipping");
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
      await ch.send(msg.externalUserId, outgoing);
      log.info(
        { agent: agentName, channel: msg.channel, turns: result.turns, status: result.status },
        "turn complete",
      );
    } catch (err) {
      log.error({ err, agent: agentName }, "turn failed");
      await ch
        .send(msg.externalUserId, { text: `Error: ${(err as Error).message}` })
        .catch(() => undefined);
    }
  });

  await bus.startAll();

  const schedules = await loadSchedules(config.brain.path);
  // Scheduled cron fires share the supervisor's resources (sessions DB,
  // attachments, dispatcher) so they take the same per-message-container path
  // as channel inbounds in docker mode.
  const running = startScheduler(config, schedules, {
    sessions,
    attachments,
    transcriber,
    dispatcher,
  });

  // Runtime scheduling: poll the ScheduleStore for due rows armed by agents
  // (via the schedule_message tool) and dispatch them the same way.
  const poller = startSchedulePoller(config, {
    store: scheduleStore,
    sessions,
    attachments,
    transcriber,
    dispatcher,
  });

  log.info(
    { schedules: running.length, channels: channels.length, dispatcher: dispatcher.id },
    "daedalus serving",
  );

  const shutdown = async () => {
    log.info("shutting down");
    poller.stop();
    for (const r of running) r.job.stop();
    await bus.stopAll();
    sessions.close();
    scheduleStore.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function buildTranscriber(config: ArtemisConfig): Transcriber {
  const cfg = config.transcribe;
  if (cfg.backend === "openai-whisper") {
    if (!cfg.apiKey) {
      log.warn("transcribe.backend=openai-whisper but no apiKey — falling back to noop");
      return new NoopTranscriber();
    }
    return new OpenAITranscriber({
      apiKey: cfg.apiKey,
      ...(cfg.baseUrl ? { baseUrl: cfg.baseUrl } : {}),
      ...(cfg.model ? { model: cfg.model } : {}),
    });
  }
  return new NoopTranscriber();
}
