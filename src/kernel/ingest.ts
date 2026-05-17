import type { ContentPart } from "../types.js";
import type { IncomingMessage } from "../channels/base.js";
import type { SessionStore } from "../sessions/store.js";
import type { AttachmentStore } from "../attachments/store.js";
import type { Transcriber } from "../attachments/transcribe.js";
import { formatGap } from "../brain/now.js";
import { log } from "../log.js";

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
