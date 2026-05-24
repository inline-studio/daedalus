import type { ContentPart } from "../types.js";
import type { IncomingMessage } from "../channels/base.js";
import type { SessionStore } from "../sessions/store.js";
import type { AttachmentStore } from "../attachments/store.js";
import type { Transcriber } from "../attachments/transcribe.js";
import { formatGap } from "../brain/now.js";
import { loadAgent } from "../brain/agents.js";
import { loadAgentCommands, detectSlashCommand, resolveCommand } from "../brain/commands.js";
import { log } from "../log.js";
import type { ArtemisConfig } from "../config/schema.js";

// Run by the SUPERVISOR before dispatching to an agent. Does all the IO-side work
// that wants to happen exactly once per inbound message:
//   - resolve user / get-or-create session
//   - download attachments, store, transcribe audio
//   - build the inbound content parts (including a session-resume marker if the
//     user was quiet for a while)
//   - persist the user message into the session
//
// Returns the session id + user id so the dispatcher can pick up where the
// supervisor left off (the agent reads the session tail from the mounted sqlite
// and proceeds from there).
export interface IngestArgs {
  agentName: string;
  incoming: IncomingMessage;
  sessions: SessionStore;
  attachments: AttachmentStore;
  transcriber: Transcriber;
  // Required for slash-command expansion: we need to look up the agent's
  // manifest to find its declared commands, and the brain path to load the
  // command bodies. Optional so existing callers that don't care about
  // commands (e.g. the scheduler) keep working.
  config?: ArtemisConfig;
}

export interface IngestResult {
  sessionId: string;
  userId: string;
  // Whether the inbound is a resume of an open ask_user (the agent will see a
  // tool_result that answers it). Surface so the caller can log if it wants.
  resumedAskUser: boolean;
}

const RESUME_THRESHOLD_MS = 60 * 60_000; // 1 hour

export async function ingestIncomingMessage(args: IngestArgs): Promise<IngestResult> {
  const { agentName, incoming, sessions, attachments, transcriber } = args;

  const userId = sessions.resolveUser(incoming.channel, incoming.externalUserId);
  const session = sessions.getOrCreateSession(userId, agentName);

  // Session-resume gap (latest prior message → now). Used to slip a small marker
  // into the next user message so the model knows time has passed.
  const priorTail = sessions.tail(session.id, 1);
  const lastMsg = priorTail[priorTail.length - 1];
  const sessionGapMs = lastMsg ? Date.now() - new Date(lastMsg.createdAt).getTime() : 0;

  const inboundParts: ContentPart[] = [];
  if (sessionGapMs >= RESUME_THRESHOLD_MS) {
    inboundParts.push({
      type: "text",
      text: `[session resumed after ${formatGap(sessionGapMs)} of inactivity]`,
    });
  }
  // Slash-command expansion. If the user typed `/ship` and the receiving
  // agent has `commands: ['*']` (or `['ship']`), prepend the command body as
  // a separate text block so the model sees what to do before reading the
  // user's args. Unknown / not-allowed commands pass through verbatim so the
  // agent can decide whether it was a typo.
  if (incoming.text) {
    const expanded = await maybeExpandSlashCommand(incoming.text, agentName, args.config);
    for (const part of expanded) inboundParts.push(part);
  }
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
      // Include the on-disk path so the agent can read it straight away (e.g. a PDF via
      // the pdf-reader skill) without a read_attachment round-trip. The attachments dir is
      // on the shared /data volume, mounted at the same path in the agent's container.
      const stored = await attachments.resolve(meta.ref);
      inboundParts.push({
        type: "text",
        text: stored
          ? `[attachment ${a.filename ?? a.mediaType} (${a.mediaType}) saved at ${stored} — ref ${meta.ref}]`
          : `[attachment ${a.filename ?? a.mediaType} stored as ${meta.ref}]`,
      });
    }
  }
  if (inboundParts.length === 0) {
    inboundParts.push({ type: "text", text: "" });
  }

  sessions.appendMessage({
    sessionId: session.id,
    role: "user",
    content: inboundParts,
    ...(incoming.channel ? { channel: incoming.channel } : {}),
    ...(incoming.externalMessageId ? { externalMessageId: incoming.externalMessageId } : {}),
  });

  return {
    sessionId: session.id,
    userId,
    resumedAskUser: false, // top-level channel inbounds don't resume ask_user
  };
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

// Detect + expand a leading slash-command. Returns a list of ContentParts that
// should replace the raw text input. Three outcomes:
//   - text isn't `/word …`               → [text part with the original]
//   - `/word` but agent has no commands  → [text part with the original]
//   - `/word` matches a loaded command   → [text(preamble + body), text(user args)]
// Always returns at least one part so we never drop the user's input.
async function maybeExpandSlashCommand(
  text: string,
  agentName: string,
  config: ArtemisConfig | undefined,
): Promise<ContentPart[]> {
  const slash = detectSlashCommand(text);
  if (!slash || !config) {
    return [{ type: "text", text }];
  }
  // Load the receiving agent's manifest to find its declared commands.
  // Failure to load (missing manifest) just passes through — the dispatcher
  // will surface the real error.
  let declared: string[] | undefined;
  try {
    const loaded = await loadAgent(config.brain.path, agentName);
    declared = loaded.manifest.commands;
  } catch {
    return [{ type: "text", text }];
  }
  if (!declared || declared.length === 0) {
    return [{ type: "text", text }];
  }
  const available = await loadAgentCommands(config.brain.path, declared);
  const match = resolveCommand(available, slash.name);
  if (!match) {
    return [{ type: "text", text }];
  }
  log.info({ command: match.manifest.name, agent: agentName }, "slash-command expanded");
  // Preamble is wrapped in clear markers so the agent knows what's the
  // command instruction vs the user's args.
  const preamble =
    `[slash-command /${match.manifest.name} invoked — instructions follow]\n\n` +
    `${match.body}\n\n` +
    `[end of /${match.manifest.name} instructions; user-provided args below]`;
  const parts: ContentPart[] = [{ type: "text", text: preamble }];
  if (slash.rest.trim()) {
    parts.push({ type: "text", text: slash.rest });
  }
  return parts;
}
