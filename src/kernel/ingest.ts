import type { ContentPart } from "../types.js";
import type { IncomingMessage } from "../channels/base.js";
import type { SessionStore } from "../sessions/store.js";
import type { AttachmentStore } from "../attachments/store.js";
import type { AttachmentIndexStore } from "../attachments/index-store.js";
import type { Transcriber } from "../attachments/transcribe.js";
import { formatGap } from "../brain/now.js";
import { loadAgent } from "../brain/agents.js";
import { loadAgentCommands, detectSlashCommand, resolveCommand } from "../brain/commands.js";
import { loadSkill, listSkills, matchSkillTriggers } from "../brain/skills.js";
import { log } from "../log.js";
import { fetchBytes } from "../web/fetch.js";
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
  // Per-user catalogue of uploaded files (find_attachment). Optional: undefined when
  // sessions.attachmentIndex.enabled is false, in which case nothing is recorded.
  attachmentIndex?: AttachmentIndexStore;
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
  // An EPHEMERAL turn directive (a matched skill trigger's inlined instructions). It must reach
  // the model for THIS turn but is deliberately NOT persisted — persisting it bloated the stored
  // user message and re-sent the whole skill body on every later turn. The dispatcher carries it
  // to the turn, which injects it into the model's view of the last user message only.
  turnDirective?: string;
}

const RESUME_THRESHOLD_MS = 60 * 60_000; // 1 hour

export async function ingestIncomingMessage(args: IngestArgs): Promise<IngestResult> {
  const { agentName, incoming, sessions, attachments, attachmentIndex, transcriber } = args;

  const userId = sessions.resolveUser(incoming.channel, incoming.externalUserId);
  // Web conversations: when the message names a specific conversation, append to that session
  // instead of the default/"Main" one — but only after confirming it belongs to this user and
  // agent (defence in depth; the web channel validates too). Anything that fails the check
  // falls back to the default session rather than erroring, so a stale client id can't wedge a
  // turn. Other channels never set conversationId and always get the default session.
  const session = resolveSession(sessions, userId, agentName, incoming.conversationId);

  // Session-resume gap (latest prior message → now). Used to slip a small marker
  // into the next user message so the model knows time has passed.
  const priorTail = sessions.tail(session.id, 1);
  const lastMsg = priorTail[priorTail.length - 1];
  const sessionGapMs = lastMsg ? Date.now() - new Date(lastMsg.createdAt).getTime() : 0;

  const inboundParts: ContentPart[] = [];
  let turnDirective: string | undefined;
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
    // Skill triggers: plain phrases declared in SKILL.md frontmatter (`triggers:`).
    // A match prepends a preamble with the skill body inlined, so the agent can
    // act without a load_skill round-trip — the model still runs the turn, so
    // mixed messages keep working. Skipped for slash-commands, which have their
    // own expansion below.
    if (!detectSlashCommand(incoming.text)) {
      // Capture the skill-trigger preamble as an EPHEMERAL directive rather than persisting it
      // into the user message (which dumped the whole skill body into the chat + re-sent it every
      // later turn). The user's own text is still persisted below via maybeExpandSlashCommand.
      const preamble = await maybeSkillTriggerPreamble(incoming.text, agentName, args.config);
      if (preamble && preamble.type === "text") turnDirective = preamble.text;
    }
    const expanded = await maybeExpandSlashCommand(incoming.text, agentName, args.config);
    for (const part of expanded) inboundParts.push(part);
  }
  for (const a of incoming.attachments ?? []) {
    const buf = a.data ?? (a.url ? await fetchAttachmentBytes(a.url, args.config) : null);
    if (!buf) continue;
    const meta = await attachments.putBuffer(buf, a.mediaType, a.filename);
    // Catalogue images + documents so the user can re-reference them in a later session via
    // find_attachment. Voice notes (audio) are skipped — the useful artifact is the inlined
    // transcript, not the blob, and indexing them would clutter the catalogue.
    if (attachmentIndex && a.kind !== "audio") {
      attachmentIndex.record({
        ref: meta.ref,
        userId,
        filename: a.filename ?? null,
        mediaType: a.mediaType,
        bytes: buf.length,
        sessionId: session.id,
      });
    }
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
      if (transcript) {
        inboundParts.push({ type: "text", text: `[voice transcript] ${transcript}` });
      } else {
        // No transcript → the raw audio part is dropped by text providers, so without a
        // text note the agent receives an effectively empty turn and replies "How can I
        // help?". Always leave it something actionable to say.
        const why =
          transcriber.id === "noop"
            ? "voice transcription isn't configured for this assistant"
            : "the transcription attempt failed";
        log.warn(
          { backend: transcriber.id, mediaType: a.mediaType, bytes: buf.length },
          "audio attachment could not be transcribed",
        );
        inboundParts.push({
          type: "text",
          text:
            `[The user sent a voice message, but ${why}, so no transcript is available. ` +
            `Tell the user you can't process voice notes right now and ask them to send it as text.]`,
        });
      }
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

  // Auto-title a brand-new, still-untitled conversation from its first user message, so the
  // web UI's conversation list shows something meaningful instead of "New chat". priorTail
  // being empty means this was the first message in the session, which also keeps us from
  // ever retitling an existing ("Main") session that predates conversation titles.
  if (session.title === null && priorTail.length === 0 && incoming.text) {
    const title = titleFromText(incoming.text);
    if (title) sessions.setSessionTitle(session.id, title);
  }

  return {
    sessionId: session.id,
    userId,
    resumedAskUser: false, // top-level channel inbounds don't resume ask_user
    ...(turnDirective ? { turnDirective } : {}),
  };
}

// Pick the session a message lands in. With a conversationId, use that session iff it exists
// and belongs to this (user, agent); otherwise fall back to the default/"Main" session. The
// fallback (rather than throwing) means a stale/forged id degrades to the main conversation
// instead of failing the turn.
function resolveSession(
  sessions: SessionStore,
  userId: string,
  agentName: string,
  conversationId: string | undefined,
) {
  if (conversationId) {
    const explicit = sessions.getSessionById(conversationId);
    if (explicit && explicit.userId === userId && explicit.agentName === agentName) {
      return explicit;
    }
  }
  return sessions.getOrCreateSession(userId, agentName);
}

// Derive a short conversation title from the first user message: first non-empty line,
// collapsed whitespace, truncated to ~50 chars with an ellipsis. Returns "" if there's
// nothing usable (caller leaves the title null in that case).
function titleFromText(text: string): string {
  const firstLine = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  if (!collapsed) return "";
  return collapsed.length > 50 ? collapsed.slice(0, 49).trimEnd() + "…" : collapsed;
}

// SEC-05: fetch an inbound attachment URL with the SSRF guard, a size cap, and a timeout
// (an inbound message's attachment.url is attacker-influenced). Returns null on any failure
// — including a blocked internal/private host — so the attachment is simply skipped.
async function fetchAttachmentBytes(
  url: string,
  config: ArtemisConfig | undefined,
): Promise<Buffer | null> {
  try {
    const { buffer } = await fetchBytes(url, {
      ...(config ? { maxBytes: config.attachments.maxFetchBytes } : {}),
      ...(config ? { timeoutMs: config.attachments.fetchTimeoutMs } : {}),
      ...(config ? { allowHosts: config.web.fetch.allowHosts } : {}),
    });
    return buffer;
  } catch (err) {
    log.warn({ url, err: (err as Error).message }, "fetch attachment failed");
    return null;
  }
}

// Check a plain message against the trigger phrases of the receiving agent's
// skills. On a match, return a preamble part carrying the matched skills'
// instructions inline — mirroring slash-command expansion — so the agent can
// act on the message in one model call instead of spending a round-trip on
// load_skill for a file that's already known. Returns null when nothing
// matches, config is unavailable, or the agent can't be loaded (the dispatcher
// surfaces that error itself).
async function maybeSkillTriggerPreamble(
  text: string,
  agentName: string,
  config: ArtemisConfig | undefined,
): Promise<ContentPart | null> {
  if (!config) return null;
  let declared: string[];
  try {
    const loaded = await loadAgent(config.brain.path, agentName);
    declared = loaded.manifest.skills;
  } catch {
    return null;
  }
  if (declared.length === 0) return null;
  const skillNames = declared.includes("*") ? await listSkills(config.brain.path) : declared;
  const skills = (
    await Promise.all(skillNames.map((s) => loadSkill(config.brain.path, s)))
  ).filter((s): s is NonNullable<typeof s> => s !== null);
  const matches = matchSkillTriggers(text, skills.map((s) => s.manifest));
  if (matches.length === 0) return null;
  log.info({ matches, agent: agentName }, "skill trigger matched");
  const lines = matches.map(
    (m) => `- "${m.trigger}" is a declared trigger for the skill \`${m.skill}\``,
  );
  // Inline each matched skill's body once (a skill can declare several trigger
  // phrases). The instructions are wrapped in clear markers, same as
  // slash-command expansion, so the agent can tell skill content from user text.
  const matchedNames = [...new Set(matches.map((m) => m.skill))];
  const bodies = matchedNames
    .map((name) => skills.find((s) => s.manifest.name === name))
    .filter((s): s is NonNullable<typeof s> => s !== undefined)
    .map(
      (s) =>
        `[skill \`${s.manifest.name}\` instructions follow]\n\n` +
        `${s.body}\n\n` +
        `[end of \`${s.manifest.name}\` instructions]`,
    );
  return {
    type: "text",
    text:
      `[skill trigger matched — the message below contains a phrase that maps to a skill:\n` +
      `${lines.join("\n")}\n` +
      `The matched skill's instructions are included below — act on the user's message ` +
      `through them rather than replying with a purely conversational answer — unless the ` +
      `message clearly only mentions the phrase without intending the action. No load_skill ` +
      `call is needed for these skills.]\n\n` +
      bodies.join("\n\n"),
  };
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
