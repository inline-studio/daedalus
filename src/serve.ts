import type { ArtemisConfig } from "./config/schema.js";
import { applyOneCli } from "./secrets/onecli.js";
import { SessionStore } from "./sessions/store.js";
import { ScheduleStore } from "./sessions/schedule-store.js";
import { AttachmentStore } from "./attachments/store.js";
import { AttachmentIndexStore } from "./attachments/index-store.js";
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
import { listAgents } from "./brain/agents.js";
import { createRequire } from "node:module";
import { Cron } from "croner";
import { SkillLearningStore } from "./sessions/skill-learning-store.js";
import { runSkillCurator } from "./brain/skill-curator.js";
import { getRpcToken } from "./channels/remote-exec.js";
import { WebChannel } from "./channels/web.js";
import { ActivityRegistry, withActivityTracking } from "./kernel/activity.js";
import { log } from "./log.js";

const PKG_VERSION = (createRequire(import.meta.url)("../package.json") as { version: string }).version;

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
  // Per-user catalogue of uploaded files (find_attachment recall). Shares the sessions
  // sqlite; only created when enabled, and ingest skips recording when it's absent.
  const attachmentIndex = config.sessions.attachmentIndex.enabled
    ? new AttachmentIndexStore(config.sessions.dbPath)
    : undefined;
  const transcriber = buildTranscriber(config);
  // Ensure the local Whisper model is downloaded (speaches won't auto-fetch it). Fire and
  // forget so serving isn't blocked on the download; it's idempotent across restarts.
  void provisionWhisperModel(config);

  // With persistentAgent, top-level turns go to the long-lived warm worker over HTTP
  // (subagents inside it still spawn ephemeral containers). Otherwise the supervisor
  // dispatches each turn itself per the configured dispatcher. Wrapped with activity
  // tracking — the single choke point every top-level turn (channel + scheduled) flows
  // through — so GET /activity can show what every agent is doing right now.
  const activity = new ActivityRegistry();
  const dispatcher: AgentDispatcher = withActivityTracking(
    config.runtime.persistentAgent
      ? new PersistentContainerDispatcher(config)
      : buildDispatcher(config),
    activity,
  );
  log.info({ dispatcher: dispatcher.id }, "supervisor dispatcher selected");

  // GET /status snapshot for the web UI's status bar. Everything is resolved lazily at
  // request time (agents/schedules re-read from the brain so edits show up live); a
  // failure in any part degrades to a partial snapshot rather than an error.
  const status = async (): Promise<Record<string, unknown>> => {
    const [agents, staticSchedules] = await Promise.all([
      listAgents(config.brain.path).catch(() => [] as string[]),
      loadSchedules(config.brain.path).catch(() => []),
    ]);
    let dynamicSchedules = 0;
    try {
      dynamicSchedules = scheduleStore.countActive();
    } catch {
      /* partial snapshot is fine */
    }
    return {
      version: PKG_VERSION,
      dispatcher: dispatcher.id,
      agents: { count: agents.length, names: agents },
      schedules: { static: staticSchedules.filter((s) => s.enabled !== false).length, dynamic: dynamicSchedules },
      memory: { backend: config.memory.backend },
      channels: Object.entries(config.channels)
        .filter(([, c]) => (c as { enabled?: boolean } | undefined)?.enabled)
        .map(([name]) => name),
    };
  };

  // Stop button: abort the in-flight turn for a conversation via the dispatcher's own
  // mechanism (AbortSignal / worker forward / docker rm). The set remembers which
  // conversations were deliberately stopped so the dispatch failure that follows is
  // reported as a quiet "stopped", not an error.
  const abortedConvos = new Set<string>();
  const abortTurn = async (conversationId: string): Promise<boolean> => {
    const ok = (await dispatcher.abort?.(conversationId)) ?? false;
    if (ok) {
      abortedConvos.add(conversationId);
      log.info({ conversationId }, "turn abort requested by user");
    }
    return ok;
  };

  // GET /schedules viewer: static brain schedules + live agent-armed rows, read fresh
  // per request so brain edits and newly-armed callbacks show up without a restart.
  const listSchedulesForUi = async (): Promise<Record<string, unknown>> => {
    const statics = await loadSchedules(config.brain.path).catch(() => []);
    let dynamic: unknown[] = [];
    try {
      dynamic = scheduleStore.listActive().map((s) => ({
        id: s.id,
        agent: s.agentName,
        prompt: s.prompt.length > 140 ? s.prompt.slice(0, 140) + "…" : s.prompt,
        nextFire: s.dueAt,
        recurring: s.recurringCron,
        createdBy: s.createdByAgent,
      }));
    } catch {
      /* partial view is fine */
    }
    return {
      static: statics.map((s) => ({
        name: s.name,
        agent: s.agent,
        schedule: s.schedule,
        enabled: s.enabled !== false,
      })),
      dynamic,
    };
  };

  // Skills panel: the live library + the pending-approval queue, with the lifecycle
  // actions the self-learning system already defines (approve/reject/pin/unpin/archive).
  // Mutations require a writable brain — the same gate skill_manage enforces.
  const skillsProvider = {
    list: async (): Promise<Record<string, unknown>> => {
      const { listPendingSkills } = await import("./tools/skill-manage.js");
      const { listSkills, loadSkill } = await import("./brain/skills.js");
      const names = await listSkills(config.brain.path).catch(() => []);
      const skills: Array<Record<string, unknown>> = [];
      for (const n of names) {
        const s = await loadSkill(config.brain.path, n).catch(() => null);
        if (!s) continue;
        skills.push({
          name: s.manifest.name,
          description: s.manifest.description,
          version: s.manifest.version,
          origin: s.manifest.origin,
          status: s.manifest.status,
          pinned: s.manifest.pinned,
          triggers: s.manifest.triggers,
        });
      }
      const pending = await listPendingSkills(config.brain.path).catch(() => []);
      return { skills, pending, writable: config.brain.writable };
    },
    action: async (name: string, action: string): Promise<{ ok: boolean; error?: string }> => {
      if (!config.brain.writable) {
        return { ok: false, error: "the brain is mounted read-only (brain.writable is false)" };
      }
      const sm = await import("./tools/skill-manage.js");
      try {
        if (action === "approve") await sm.approvePendingSkill(config.brain.path, name);
        else if (action === "reject") await sm.rejectPendingSkill(config.brain.path, name);
        else if (action === "pin") await sm.setSkillPinned(config.brain.path, name, true);
        else if (action === "unpin") await sm.setSkillPinned(config.brain.path, name, false);
        else if (action === "archive") await sm.archiveSkill(config.brain.path, name);
        else return { ok: false, error: `unknown action '${action}'` };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  };

  // Artifacts panel: the per-user attachment catalogue (uploads + agent-generated files),
  // with ownership-checked downloads out of the content-addressable store.
  const artifactsProvider = {
    list: async (userId: string, q: string): Promise<Array<Record<string, unknown>>> => {
      if (!attachmentIndex) return [];
      const rows = q.trim() ? attachmentIndex.search(userId, q, 50) : attachmentIndex.recent(userId, 50);
      return rows.map((r) => ({
        ref: r.ref,
        filename: r.filename,
        mediaType: r.mediaType,
        bytes: r.bytes,
        summary: r.summary,
        uploadedAt: r.uploadedAt,
      }));
    },
    read: async (
      userId: string,
      ref: string,
    ): Promise<{ data: Buffer; mediaType: string; filename?: string } | null> => {
      if (!attachmentIndex) return null;
      const meta = attachmentIndex.getByRef(userId, ref);
      if (!meta) return null;
      const data = await attachments.readBuffer(ref);
      if (!data) return null;
      return { data, mediaType: meta.mediaType, ...(meta.filename ? { filename: meta.filename } : {}) };
    },
  };

  const channels = buildChannels(config.channels, sessions, config.identity.name, config.brain.path, {
    status,
    abort: abortTurn,
    schedules: listSchedulesForUi,
    activity: async (userId) => activity.listForUser(userId) as unknown as Array<Record<string, unknown>>,
    skills: skillsProvider,
    artifacts: artifactsProvider,
    // Dictation only when a real transcriber is configured — a noop would give the UI a
    // mic that always fails.
    ...(transcriber.id !== "noop" ? { transcribe: (a: Buffer, m: string) => transcriber.transcribe(a, m) } : {}),
  });
  if (channels.length === 0) {
    log.error(
      "No channels enabled in config.channels — nothing to listen on. Enable at least one (cli/web/telegram/whatsapp).",
    );
    return;
  }

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
        ...(attachmentIndex ? { attachmentIndex } : {}),
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
      // Remote execution: when this message's user has a `dae remote` executor connected
      // (web channel only), the turn's tools run on THEIR machine. The bridge URL defaults
      // by dispatch topology: in-process turns reach the supervisor on loopback; container/
      // worker turns reach it by compose service name on the daedalus network.
      let remoteExec:
        | { userId: string; url: string; token: string; executorId?: string; env?: Record<string, string> }
        | undefined;
      const webCfg = config.channels.web;
      if (
        webCfg?.remoteExec.enabled &&
        msg.execution !== "server" && // per-message opt-out (WS6e); default is local
        ch instanceof WebChannel &&
        ch.remoteConnected(ingested.userId)
      ) {
        const port = webCfg.port ?? 8765;
        const url =
          webCfg.remoteExec.internalUrl ??
          (dispatcher.id === "in-process" ? `http://127.0.0.1:${port}` : `http://daedalus:${port}`);
        // Pin the turn to the SENDING client's machine (msg.executorId) when that
        // executor is alive, else the most recently connected one — resolved up front
        // so mid-turn connects/disconnects don't move the target.
        const executorId = ch.resolveExecutorId(ingested.userId, msg.executorId);
        const env = ch.executorInfo(ingested.userId, executorId) ?? undefined;
        remoteExec = {
          userId: ingested.userId,
          url,
          token: getRpcToken(),
          ...(executorId ? { executorId } : {}),
          ...(env ? { env } : {}),
        };
        log.info({ user: ingested.userId, executorId, ...env }, "remote executor connected — turn will execute locally on it");
      }
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
        ...(ingested.turnDirective ? { turnDirective: ingested.turnDirective } : {}),
        ...(remoteExec ? { remoteExec } : {}),
      });
      // Pre-reply messages, delivered as their own short bubbles before the reply lands:
      //   - surfaced thinking, but ONLY for buffered channels — streaming channels already render
      //     it inline (delivering here too would double it);
      //   - system notices (e.g. "I compacted our earlier conversation").
      const preMessages = [
        ...(!streaming && result.thinkingMessages ? result.thinkingMessages : []),
        ...(result.notices ?? []),
      ];
      for (const n of preMessages) {
        await ch
          .send(msg.externalUserId, { text: n, ...(conversationId ? { conversationId } : {}) })
          .catch(() => undefined);
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
      // A late Stop that didn't land (the turn finished first) shouldn't mislabel the
      // NEXT failure in this conversation as a deliberate stop.
      if (conversationId) abortedConvos.delete(conversationId);
      // The debug-log pointer is no longer sent as its own message — it's surfaced as activity
      // chrome via the `debug_log` turn event (streaming channels), alongside tool/reasoning.
      log.info(
        { agent: agentName, channel: msg.channel, turns: result.turns, status: result.status },
        "turn complete",
      );
    } catch (err) {
      // A deliberately stopped turn is not an error — the user pressed Stop, so the
      // dispatch failing is exactly what they asked for. Quiet notice, no scary message.
      if (conversationId && abortedConvos.delete(conversationId)) {
        log.info({ agent: agentName, conversationId }, "turn stopped by user");
        await ch
          .send(msg.externalUserId, { text: "⏹ Stopped.", conversationId })
          .catch(() => undefined);
        return;
      }
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

  // Skill staleness curator: a deterministic cron sweep that ages unused agent-created
  // skills out (stale → archived, never deleted). Needs the brain writable — without that
  // there's nothing it could do, so it simply doesn't start.
  let curatorJob: Cron | undefined;
  let skillLearningStore: SkillLearningStore | undefined;
  const learning = config.skills.learning;
  if (learning.enabled && learning.curator.enabled && config.brain.writable) {
    skillLearningStore = new SkillLearningStore(config.sessions.dbPath);
    const store = skillLearningStore;
    curatorJob = new Cron(learning.curator.schedule, async () => {
      try {
        await runSkillCurator({
          brainPath: config.brain.path,
          store,
          staleAfterDays: learning.curator.staleAfterDays,
          archiveAfterDays: learning.curator.archiveAfterDays,
        });
      } catch (err) {
        log.warn({ err: (err as Error).message }, "skill-curator: sweep threw (ignored)");
      }
    });
    log.info({ schedule: learning.curator.schedule }, "skill curator armed");
  }

  log.info(
    { schedules: running.length, channels: channels.length, dispatcher: dispatcher.id },
    "daedalus serving",
  );

  const shutdown = async () => {
    log.info("shutting down");
    poller.stop();
    curatorJob?.stop();
    for (const r of running) r.job.stop();
    await bus.stopAll();
    sessions.close();
    scheduleStore.close();
    skillLearningStore?.close();
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
