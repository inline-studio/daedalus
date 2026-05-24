// Smoke for inbound audio handling: a voice note must never produce an empty turn.
//  - With no transcription (Noop), the agent still gets a text note explaining it can't
//    process the audio (so it doesn't reply "How can I help?" to a blank message).
//  - With transcription, the transcript is injected as text.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ingestIncomingMessage } from "../dist/kernel/ingest.js";
import { SessionStore } from "../dist/sessions/store.js";
import { AttachmentStore } from "../dist/attachments/store.js";
import { NoopTranscriber } from "../dist/attachments/transcribe.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dae-audio-"));
const sessions = new SessionStore(path.join(tmp, "sessions.sqlite"));
const attachments = new AttachmentStore(path.join(tmp, "attachments"));
await attachments.ensureDir();

const audioMsg = (uid) => ({
  channel: "telegram",
  externalUserId: uid,
  attachments: [{ kind: "audio", mediaType: "audio/ogg", data: Buffer.from([1, 2, 3, 4]) }],
});
const textOf = (m) => m.content.filter((c) => c.type === "text").map((c) => c.text).join(" ");

// 1. No transcription (Noop) → actionable text note, never an empty turn.
{
  const res = await ingestIncomingMessage({
    agentName: "artemis",
    incoming: audioMsg("u1"),
    sessions,
    attachments,
    transcriber: new NoopTranscriber(),
  });
  const tail = sessions.tail(res.sessionId, 10);
  const last = tail[tail.length - 1];
  const text = textOf(last);
  expect("untranscribed audio leaves an actionable text note", /voice message/i.test(text) && /text/i.test(text), text.slice(0, 90));
  expect("the turn is not empty", last.content.some((c) => c.type === "text" && c.text.trim().length > 0));
}

// 2. With transcription → the transcript is injected as text.
{
  const fakeTranscriber = { id: "fake", async transcribe() { return "buy milk tomorrow"; } };
  const res = await ingestIncomingMessage({
    agentName: "artemis",
    incoming: audioMsg("u2"),
    sessions,
    attachments,
    transcriber: fakeTranscriber,
  });
  const tail = sessions.tail(res.sessionId, 10);
  const text = textOf(tail[tail.length - 1]);
  expect("transcribed audio injects the transcript", /voice transcript.*buy milk tomorrow/i.test(text), text.slice(0, 90));
}

sessions.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
