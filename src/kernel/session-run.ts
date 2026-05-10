import path from "node:path";
import type { ArtemisConfig, AgentManifest } from "../config/schema.js";
import type { ContentPart, Message } from "../types.js";
import { Kernel } from "./agent.js";
import { buildProvider } from "../providers/index.js";
import { buildRuntime } from "../runtime/factory.js";
import { selectBuiltins } from "../tools/registry.js";
import { composeSystemPrompt } from "../brain/composer.js";
import { loadSkill } from "../brain/skills.js";
import { connectMcpServer, type ConnectedServer } from "../mcp/client.js";
import { loadMcpConfig } from "../mcp/loader.js";
import { buildSpawnSubagentTool } from "./orchestrator.js";
import { SessionStore, type PersistedMessage } from "../sessions/store.js";
import { AttachmentStore } from "../attachments/store.js";
import type { Transcriber } from "../attachments/transcribe.js";
import type { IncomingMessage } from "../channels/base.js";
import { readAttachmentTool } from "../tools/attachment.js";
import { buildSecretsBackend } from "../secrets/store/factory.js";
import { resolveProviderKey } from "../providers/resolve.js";
import { formatGap } from "../brain/now.js";
import { log } from "../log.js";

export interface SessionRunInput {
  config: ArtemisConfig;
  agent: AgentManifest;
  agentBody: string;
  incoming: IncomingMessage;
  sessions: SessionStore;
  attachments: AttachmentStore;
  transcriber: Transcriber;
  // Persistent shared MCP connections (the serve loop owns them).
  mcpServers: Map<string, ConnectedServer>;
}

export interface SessionRunResult {
  finalText: string;
  turns: number;
  userId: string;
}

// One end-to-end turn driven by an inbound channel message.
//
// 1. Resolve user (channel + externalId → userId).
// 2. Get-or-create the (user, agent) session.
// 3. Ingest attachments (store, transcribe audio, build content parts).
// 4. Persist the inbound user message.
// 5. Load history tail.
// 6. Run the kernel.
// 7. Persist the assistant's response.
export async function runSession(input: SessionRunInput): Promise<SessionRunResult> {
  const { config, agent, agentBody, incoming, sessions, attachments, transcriber } = input;

  const userId = sessions.resolveUser(incoming.channel, incoming.externalUserId);
  const session = sessions.getOrCreateSession(userId, agent.name);

  // 1. Determine session-resume gap (latest prior message → now)
  const priorTail = sessions.tail(session.id, 1);
  const lastMsg = priorTail[priorTail.length - 1];
  const sessionGapMs = lastMsg ? Date.now() - new Date(lastMsg.createdAt).getTime() : 0;
  const RESUME_THRESHOLD_MS = 60 * 60_000; // 1 hour

  // 2. Build inbound content parts
  const inboundParts: ContentPart[] = [];
  if (sessionGapMs >= RESUME_THRESHOLD_MS) {
    // Prepend a single text block visible to the model so it knows time has passed.
    inboundParts.push({
      type: "text",
      text: `[session resumed after ${formatGap(sessionGapMs)} of inactivity]`,
    });
  }
  if (incoming.text) inboundParts.push({ type: "text", text: incoming.text });
  for (const a of incoming.attachments ?? []) {
    const buf = a.data ?? (a.url ? await fetchUrl(a.url) : null);
    if (!buf) continue;
    const meta = await attachments.putBuffer(buf, a.mediaType, a.filename);
    if (a.kind === "image") {
      inboundParts.push({
        type: "image",
        source: { kind: "base64", mediaType: a.mediaType, data: buf.toString("base64") },
      });
      inboundParts.push({
        type: "file",
        filename: a.filename ?? "image",
        mediaType: a.mediaType,
        ref: meta.ref,
      });
    } else if (a.kind === "audio") {
      const transcript = await transcriber.transcribe(buf, a.mediaType).catch(() => null);
      inboundParts.push({
        type: "audio",
        mediaType: a.mediaType,
        source: { kind: "base64", data: buf.toString("base64") },
        ...(transcript ? { transcript } : {}),
      });
      if (transcript) inboundParts.push({ type: "text", text: `[voice transcript] ${transcript}` });
    } else {
      inboundParts.push({
        type: "file",
        filename: a.filename ?? "file",
        mediaType: a.mediaType,
        ref: meta.ref,
      });
      inboundParts.push({
        type: "text",
        text: `[attachment ${a.filename ?? a.mediaType} stored as ${meta.ref}]`,
      });
    }
  }
  if (inboundParts.length === 0) {
    inboundParts.push({ type: "text", text: "" });
  }

  // 2. Persist inbound
  sessions.appendMessage({
    sessionId: session.id,
    role: "user",
    content: inboundParts,
    ...(incoming.channel ? { channel: incoming.channel } : {}),
    ...(incoming.externalMessageId ? { externalMessageId: incoming.externalMessageId } : {}),
  });

  // 3. Skills + system prompt
  const skills = (
    await Promise.all(agent.skills.map((s) => loadSkill(config.brain.path, s, config.brain.writable)))
  ).filter((s): s is NonNullable<typeof s> => s !== null);
  await hydrateSkillSecrets(config, skills);
  const system = await composeSystemPrompt({
    brainPath: config.brain.path,
    agent,
    agentBody,
    skills,
    identity: config.identity.nickname
      ? { name: config.identity.name, nickname: config.identity.nickname }
      : { name: config.identity.name },
    ...(sessionGapMs > 0 ? { sessionGapMs } : {}),
  });

  // 4. MCP — filter shared connections to those this agent declares
  const mcpServers = filterMcp(input.mcpServers, agent.mcpServers);

  // 5. Resolve provider API key (env / SecretsBackend / OneCLI placeholder).
  const secretsBackend = await buildSecretsBackend(config, { envFileBaseDir: process.cwd() });
  await resolveProviderKey(agent, config, secretsBackend);

  // 6. Provider, runtime, tools
  const provider = buildProvider(agent, config);
  const runtime = buildRuntime(agent, config);
  const builtinTools = selectBuiltins(agent.tools, config);
  builtinTools.push(readAttachmentTool(attachments));
  const orchestratorTool = buildSpawnSubagentTool({
    config,
    parent: agent,
    mcpServers,
    sessions,
    userId,
  });
  if (orchestratorTool) builtinTools.push(orchestratorTool);

  // 6. Load history tail and convert to normalized messages
  const tail = sessions.tail(session.id, config.sessions.historyLimit);
  const history: Message[] = persistedToMessages(tail);

  // 7. Run kernel — but our kernel takes a userPrompt+messages, so build a fresh kernel
  // and feed the tail as the assistant/user history. The simplest path: shove all history
  // into a Kernel by extending its API... or just run a minimal loop here.
  const kernelHistory = history.length ? history : [{ role: "user" as const, content: inboundParts }];
  const kernel = new Kernel({
    provider,
    model: agent.model,
    system,
    builtinTools,
    mcpServers,
    toolContext: {
      runtime,
      brainPath: config.brain.path,
      brainWritable: config.brain.writable,
      workspacePath: path.resolve(process.cwd()),
      agentName: agent.name,
      ...(config.runtime.shared.enabled
        ? {
            shared: {
              hostPath: config.runtime.shared.hostPath,
              containerPath: config.runtime.shared.containerPath,
            },
          }
        : {}),
    },
    maxTurns: agent.maxTurns,
    maxTokens: agent.maxTokens,
    ...(agent.temperature !== undefined ? { temperature: agent.temperature } : {}),
  });

  // For session-driven runs we want the kernel to use the prebuilt history rather than
  // a single userPrompt. Use the internal entrypoint.
  const result = await kernel.runWithMessages(kernelHistory);

  // 8. Persist assistant response
  const assistantMessage = result.messages[result.messages.length - 1];
  if (assistantMessage && assistantMessage.role === "assistant") {
    sessions.appendMessage({
      sessionId: session.id,
      role: "assistant",
      content: assistantMessage.content,
    });
  }

  return { finalText: result.finalText, turns: result.turns, userId };
}

function filterMcp(
  servers: Map<string, ConnectedServer>,
  declared: string[],
): Map<string, ConnectedServer> {
  if (declared.length === 0) return new Map();
  const filtered = new Map<string, ConnectedServer>();
  for (const name of declared) {
    const s = servers.get(name);
    if (s) filtered.set(name, s);
  }
  return filtered;
}

function persistedToMessages(tail: PersistedMessage[]): Message[] {
  // Collapse: we only need user/assistant turns, in order.
  return tail
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({ role: m.role, content: m.content }));
}

async function hydrateSkillSecrets(
  config: ArtemisConfig,
  skills: Array<{ manifest: { name: string; requires: { secrets: string[] } } }>,
): Promise<void> {
  const needed = new Set<string>();
  for (const s of skills) for (const n of s.manifest.requires.secrets) needed.add(n);
  if (needed.size === 0) return;
  const missing: string[] = [];
  let backend: Awaited<ReturnType<typeof buildSecretsBackend>> | null = null;
  for (const n of needed) {
    if (process.env[n]) continue;
    if (!backend) backend = await buildSecretsBackend(config, { envFileBaseDir: process.cwd() });
    const v = await backend.get(n).catch(() => null);
    if (!v) missing.push(n);
    else process.env[n] = v;
  }
  if (missing.length) log.warn({ missing }, "skill secrets missing");
}

async function fetchUrl(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (err) {
    log.warn({ url, err }, "fetch attachment failed");
    return null;
  }
}

// Re-exported here so the `serve` command can spin up a fresh MCP pool.
export async function connectAllMcp(
  config: ArtemisConfig,
  serverNames: Set<string>,
): Promise<Map<string, ConnectedServer>> {
  const out = new Map<string, ConnectedServer>();
  if (serverNames.size === 0) return out;
  const allDefs = await loadMcpConfig(config.mcp.configPath);
  for (const name of serverNames) {
    const def = allDefs[name];
    if (!def) continue;
    try {
      out.set(name, await connectMcpServer(name, def));
    } catch (err) {
      log.error({ name, err }, "MCP connection failed");
    }
  }
  return out;
}
