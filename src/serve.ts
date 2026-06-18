import type { ArtemisConfig } from "./config/schema.js";
import { applyOneCli } from "./secrets/onecli.js";
import { SessionStore } from "./sessions/store.js";
import { ScheduleStore } from "./sessions/schedule-store.js";
import { AttachmentStore } from "./attachments/store.js";
import { NoopTranscriber, OpenAITranscriber, type Transcriber } from "./attachments/transcribe.js";
import { provisionWhisperModel } from "./attachments/whisper-provision.js";
import { MessageBus } from "./channels/bus.js";
import { buildChannels } from "./channels/registry.js";
import type { OutgoingMessage, OutgoingAttachment } from "./channels/base.js";
import { ingestIncomingMessage } from "./kernel/ingest.js";
import { humanizeTurnError } from "./kernel/error-message.js";
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
  // Ensure the local Whisper model is downloaded (speaches won't auto-fetch it). Fire and
  // forget so serving isn't blocked on the download; it's idempotent across restarts.
  void provisionWhisperModel(config);

  const channels = buildChannels(config.channels, sessions, config.identity.name, config.brain.path);
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
    // The conversation (session) this turn ran in, captured after ingest so the reply — and
    // any error message from a later failure — is delivered back to the right web conversation
    // rather than broadcast to all of the user's open conversations. Undefined until ingest
    // resolves it (an ingest failure has no conversation context; that reply just broadcasts).
    let conversationId: string | undefined;
    try {
      const ingested = await ingestIncomingMessage({
        agentName,
        incoming: msg,
        sessions,
        attachments,
        transcriber,
        config,
      });
      conversationId = ingested.sessionId;
      // Live streaming engages when the channel can render it AND the dispatcher forwards turn
      // events (in-process, or the warm worker which streams them back over NDJSON). The sink
      // renders the reply token-by-token; we then skip the buffered final-text send below.
      const streaming =
        config.streaming.enabled &&
        typeof ch.streamSink === "function" &&
        dispatcher.streaming === true;
      const onEvent = streaming ? ch.streamSink!(msg.externalUserId, conversationId) : undefined;
      const result = await dispatcher.dispatch({
        agentName,
        sessionId: ingested.sessionId,
        userId: ingested.userId,
        isSubagent: false,
        // Origin identity so an in-turn schedule_message routes future deliveries
        // back to this channel/user instead of an orphan "scheduled" session.
        originChannel: msg.channel,
        originExternalUserId: msg.externalUserId,
        ...(onEvent ? { onEvent } : {}),
      });
      // Deliver any in-turn notices (e.g. "I compacted our earlier conversation") as their
      // own short messages first, so the user knows what happened before the reply lands.
      if (result.notices?.length) {
        for (const n of result.notices) {
          await ch
            .send(msg.externalUserId, { text: n, ...(conversationId ? { conversationId } : {}) })
            .catch(() => undefined);
        }
      }
      const reply =
        result.status === "pending_question" ? result.question : result.finalText;
      // A completed turn's reply was already streamed token-by-token by the sink, so don't resend
      // its text — but a pending question was NOT streamed (the kernel halted on ask_user), so it
      // always goes out via send().
      const replyAlreadyStreamed = Boolean(onEvent) && result.status === "complete";
      const outgoing: OutgoingMessage = {
        ...(replyAlreadyStreamed ? {} : { text: reply }),
        ...(conversationId ? { conversationId } : {}),
      };
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
      // When the reply was streamed and there's nothing else to deliver (no attachments), skip
      // send() entirely — the sink already rendered the reply and finalized the channel.
      if (!replyAlreadyStreamed || outgoing.attachments?.length) {
        await ch.send(msg.externalUserId, outgoing);
      }
      // Debug-log pointer (opt-in via config.debug.conversationLog). Delivered AFTER the reply
      // so it's the last thing the operator sees — "where to look" once the answer has landed,
      // not noise ahead of it.
      if (result.debugLogPath) {
        await ch
          .send(msg.externalUserId, {
            text: `🔍 Debug log: ${result.debugLogPath}`,
            ...(conversationId ? { conversationId } : {}),
          })
          .catch(() => undefined);
      }
      log.info(
        { agent: agentName, channel: msg.channel, turns: result.turns, status: result.status },
        "turn complete",
      );
    } catch (err) {
      // The operator gets the full stack via log.error. The USER (over telegram/web/
      // wherever) gets a humanised explanation — see kernel/error-message.ts. The raw
      // message is incomprehensible noise to anyone not reading the source.
      const classified = humanizeTurnError(err);
      log.error(
        { err, agent: agentName, category: classified.category },
        "turn failed",
      );
      await ch
        .send(msg.externalUserId, {
          text: classified.userMessage,
          ...(conversationId ? { conversationId } : {}),
        })
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
    bus, // IMP-10: lets a schedule with `deliverTo` push its reply to a real channel/user
  });

  // Runtime scheduling: poll the ScheduleStore for due rows armed by agents
  // (via the schedule_message tool) and dispatch them the same way.
  const poller = startSchedulePoller(config, {
    store: scheduleStore,
    sessions,
    attachments,
    transcriber,
    dispatcher,
    bus,
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
