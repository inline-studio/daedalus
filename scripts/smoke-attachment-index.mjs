// Smoke for the per-user attachment catalogue (find_attachment recall):
//  1. AttachmentIndexStore: record is idempotent per (user, ref), search matches filename +
//     summary, recall is scoped per user, and a re-upload preserves an existing summary.
//  2. ingest records uploaded FILES into the index but skips AUDIO voice notes, and only
//     when an index store is passed (the enabled gate).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AttachmentIndexStore } from "../dist/attachments/index-store.js";
import { ingestIncomingMessage } from "../dist/kernel/ingest.js";
import { SessionStore } from "../dist/sessions/store.js";
import { AttachmentStore } from "../dist/attachments/store.js";
import { NoopTranscriber } from "../dist/attachments/transcribe.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. Store-level behaviour.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dae-attidx-"));
  const store = new AttachmentIndexStore(path.join(dir, "sessions.sqlite"));

  store.record({ ref: "sha256:aaa", userId: "u1", filename: "Q3-report.pdf", mediaType: "application/pdf", bytes: 1234, sessionId: "s1" });
  store.record({ ref: "sha256:bbb", userId: "u1", filename: "logo.png", mediaType: "image/png", bytes: 99, sessionId: "s1" });
  store.record({ ref: "sha256:ccc", userId: "u2", filename: "other.pdf", mediaType: "application/pdf", bytes: 5, sessionId: "s2" });

  expect("search by filename fragment finds the file", store.search("u1", "report").some((h) => h.ref === "sha256:aaa"));
  expect("search is scoped per user (u1 can't see u2's file)", store.search("u1", "other").length === 0);
  expect("u2 sees only their own file", store.search("u2", "").length === 1);
  expect("empty query lists recent uploads for the user", store.search("u1", "").length === 2);

  // Summary makes content search work; re-upload must not wipe it.
  store.setSummary("u1", "sha256:aaa", "quarterly revenue figures for engineering");
  expect("search matches on summary text, not just filename", store.search("u1", "revenue").some((h) => h.ref === "sha256:aaa"));
  store.record({ ref: "sha256:aaa", userId: "u1", filename: "Q3-report-final.pdf", mediaType: "application/pdf", bytes: 1240, sessionId: "s9" });
  const reuploaded = store.search("u1", "revenue").find((h) => h.ref === "sha256:aaa");
  expect("re-upload is idempotent (no duplicate row)", store.recent("u1", 50).filter((h) => h.ref === "sha256:aaa").length === 1);
  expect("re-upload refreshes the filename", reuploaded && reuploaded.filename === "Q3-report-final.pdf");
  expect("re-upload preserves the existing summary", reuploaded && /revenue/.test(reuploaded.summary ?? ""));

  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

// 2. ingest wiring: a file attachment gets indexed; audio doesn't; the gate (no store) records nothing.
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dae-attidx-ingest-"));
  const dbPath = path.join(dir, "sessions.sqlite");
  const sessions = new SessionStore(dbPath);
  const attachments = new AttachmentStore(path.join(dir, "attachments"));
  await attachments.ensureDir();
  const index = new AttachmentIndexStore(dbPath);

  const fileMsg = {
    channel: "telegram",
    externalUserId: "alice",
    attachments: [{ kind: "file", mediaType: "application/pdf", filename: "contract.pdf", data: Buffer.from("hello pdf bytes") }],
  };
  const res = await ingestIncomingMessage({
    agentName: "artemis",
    incoming: fileMsg,
    sessions,
    attachments,
    attachmentIndex: index,
    transcriber: new NoopTranscriber(),
  });
  const userId = sessions.resolveUser("telegram", "alice");
  const indexed = index.search(userId, "contract");
  expect("uploaded file is catalogued under the user", indexed.length === 1 && indexed[0].filename === "contract.pdf");
  expect("catalogue records the upload session as provenance", indexed[0]?.sessionId === res.sessionId);

  // Audio voice note must NOT be catalogued (transient; transcript is the artifact).
  await ingestIncomingMessage({
    agentName: "artemis",
    incoming: { channel: "telegram", externalUserId: "alice", attachments: [{ kind: "audio", mediaType: "audio/ogg", data: Buffer.from([1, 2, 3]) }] },
    sessions,
    attachments,
    attachmentIndex: index,
    transcriber: new NoopTranscriber(),
  });
  expect("audio voice note is not catalogued", index.recent(userId, 50).every((h) => h.mediaType !== "audio/ogg"));

  // Gate: with no index store passed, ingest records nothing (and doesn't throw).
  const userId2 = sessions.resolveUser("telegram", "bob");
  await ingestIncomingMessage({
    agentName: "artemis",
    incoming: { channel: "telegram", externalUserId: "bob", attachments: [{ kind: "file", mediaType: "text/plain", filename: "notes.txt", data: Buffer.from("x") }] },
    sessions,
    attachments,
    transcriber: new NoopTranscriber(),
  });
  expect("with index disabled (no store), nothing is recorded", index.recent(userId2, 50).length === 0);

  index.close();
  sessions.close();
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
