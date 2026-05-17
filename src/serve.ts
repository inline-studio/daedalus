import type { ArtemisConfig } from "./config/schema.js";
import { applyOneCli } from "./secrets/onecli.js";
import { SessionStore } from "./sessions/store.js";
import { AttachmentStore } from "./attachments/store.js";
import { NoopTranscriber, OpenAITranscriber, type Transcriber } from "./attachments/transcribe.js";
import { MessageBus } from "./channels/bus.js";
import { buildChannels } from "./channels/registry.js";
import { loadAgent } from "./brain/agents.js";
import { runSession, connectAllMcp } from "./kernel/session-run.js";
import { loadSchedules, startScheduler } from "./scheduler/cron.js";
import { log } from "./log.js";

// Long-running runner. Starts every enabled channel + the scheduler, listens for
// inbound messages on the unified bus, and dispatches each one to the appropriate agent.
//
// Agent selection: incoming.addressedTo wins; otherwise the channel's defaultAgent.
// MCP servers are connected once at startup (union of every channel-default-agent's needs)
// and shared across runs.
export async function serve(config: ArtemisConfig): Promise<void> {
  await applyOneCli(config.onecli);

  const sessions = new SessionStore(config.sessions.dbPath);
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

  // Pre-resolve which agents the channels can route to so we know which MCP servers to spin up.
  const agentNames = new Set<string>();
  for (const ch of channels) agentNames.add(ch.defaultAgent);
  const agentManifests = new Map<string, Awaited<ReturnType<typeof loadAgent>>>();
  const mcpNeeds = new Set<string>();
  for (const name of agentNames) {
    const a = await loadAgent(config.brain.path, name);
    agentManifests.set(name, a);
    for (const m of a.manifest.mcpServers) mcpNeeds.add(m);
    for (const sub of a.manifest.subagents) {
      try {
        const subA = await loadAgent(config.brain.path, sub);
        agentManifests.set(sub, subA);
        for (const m of subA.manifest.mcpServers) mcpNeeds.add(m);
      } catch (err) {
        log.warn({ sub, err }, "couldn't preload subagent manifest");
      }
    }
  }

  const mcpServers = await connectAllMcp(config, mcpNeeds);
  log.info({ servers: [...mcpServers.keys()] }, "MCP servers connected");

  const bus = new MessageBus(sessions);
  for (const ch of channels) bus.register(ch);

  bus.onIncoming(async (msg) => {
    const ch = bus.channelFor(msg.channel);
    if (!ch) return;
    const agentName = msg.addressedTo ?? ch.defaultAgent;
    let manifest = agentManifests.get(agentName);
    if (!manifest) {
      try {
        manifest = await loadAgent(config.brain.path, agentName);
        agentManifests.set(agentName, manifest);
      } catch (err) {
        log.error({ agent: agentName, err }, "agent manifest load failed");
        return;
      }
    }
    try {
      const result = await runSession({
        config,
        agent: manifest.manifest,
        agentBody: manifest.body,
        incoming: msg,
        sessions,
        attachments,
        transcriber,
        mcpServers,
      });
      // Send back via the channel the message arrived on, addressed to the originating user.
      await ch.send(msg.externalUserId, { text: result.finalText });
      log.info(
        { agent: agentName, channel: msg.channel, turns: result.turns },
        "turn complete",
      );
    } catch (err) {
      log.error({ err }, "turn failed");
      await ch.send(msg.externalUserId, { text: `Error: ${(err as Error).message}` }).catch(() => undefined);
    }
  });

  await bus.startAll();

  const schedules = await loadSchedules(config.brain.path);
  const running = startScheduler(config, schedules);
  log.info({ schedules: running.length, channels: channels.length }, "daedalus serving");

  const shutdown = async () => {
    log.info("shutting down");
    for (const r of running) r.job.stop();
    await bus.stopAll();
    for (const s of mcpServers.values()) await s.close().catch(() => undefined);
    sessions.close();
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
