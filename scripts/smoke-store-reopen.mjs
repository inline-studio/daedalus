// Smoke: SessionStore + ScheduleStore self-heal when the sqlite file gets
// replaced underneath them (the trigger for "attempt to write a readonly
// database" hours later). Each public method has an ensureFreshConnection()
// call that fstat's the path; on inode mismatch it reopens the connection.
//
// We simulate replacement by: (1) opening a store, (2) writing one row,
// (3) deleting + recreating the sqlite file (new inode), (4) writing another
// row on the same store instance. Without the fix this throws "attempt to
// write a readonly database" / writes to the deleted inode.

import { mkdtempSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../dist/sessions/store.js";
import { ScheduleStore } from "../dist/sessions/schedule-store.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. SessionStore: replace file underneath, next write succeeds + lands in the
// new file.
{
  const dir = mkdtempSync(join(tmpdir(), "dae-store-reopen-"));
  const dbPath = join(dir, "sessions.sqlite");
  const store = new SessionStore(dbPath);
  const userId1 = store.resolveUser("cli", "alice");
  const inodeBefore = Number(statSync(dbPath).ino);

  // Replace the file: delete + the next write recreates a fresh inode.
  unlinkSync(dbPath);

  // Without the fix this would throw "attempt to write a readonly database"
  // because the original fd points at the now-deleted inode.
  let errored = false;
  let userId2 = "";
  try {
    userId2 = store.resolveUser("cli", "bob");
  } catch (err) {
    errored = true;
    expect(
      "SessionStore: write after file-replace did NOT throw",
      false,
      `got: ${(err).message}`,
    );
  }
  if (!errored) {
    const inodeAfter = Number(statSync(dbPath).ino);
    expect(
      "SessionStore: file was recreated (inode changed)",
      inodeAfter !== inodeBefore,
      `before=${inodeBefore} after=${inodeAfter}`,
    );
    expect(
      "SessionStore: new write returned a valid user id",
      typeof userId2 === "string" && userId2.length > 0,
    );
    // The previous user_id is GONE — that's expected behaviour when the file
    // was deleted. We're verifying the store doesn't *crash*; we're not
    // claiming pre-replace data magically survives.
    void userId1;
  }
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

// 2. ScheduleStore: same scenario, write after replace still works.
{
  const dir = mkdtempSync(join(tmpdir(), "dae-sched-reopen-"));
  const dbPath = join(dir, "sessions.sqlite");
  const store = new ScheduleStore(dbPath);
  store.enqueue({
    agentName: "artemis",
    createdByAgent: "artemis",
    prompt: "first",
    dueAt: new Date(Date.now() + 60_000).toISOString(),
  });
  unlinkSync(dbPath);
  let row;
  try {
    row = store.enqueue({
      agentName: "artemis",
      createdByAgent: "artemis",
      prompt: "second",
      dueAt: new Date(Date.now() + 60_000).toISOString(),
    });
  } catch (err) {
    expect(
      "ScheduleStore: enqueue after file-replace did NOT throw",
      false,
      `got: ${(err).message}`,
    );
  }
  expect(
    "ScheduleStore: enqueue after file-replace returned a row",
    row && typeof row.id === "string" && row.id.startsWith("sched_"),
    row ? `id=${row.id}` : "no row returned",
  );
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

// 3. Reading after replace also works — tail() should return empty (new file)
// instead of pointing at the deleted inode.
{
  const dir = mkdtempSync(join(tmpdir(), "dae-tail-reopen-"));
  const dbPath = join(dir, "sessions.sqlite");
  const store = new SessionStore(dbPath);
  const userId = store.resolveUser("cli", "alice");
  const session = store.getOrCreateSession(userId, "artemis");
  store.appendMessage({
    sessionId: session.id,
    role: "user",
    content: [{ type: "text", text: "hello" }],
  });
  unlinkSync(dbPath);
  let tail;
  try {
    tail = store.tail(session.id, 10);
  } catch (err) {
    expect("tail after file-replace did NOT throw", false, `got: ${(err).message}`);
  }
  expect("tail after file-replace returned an array (empty — new file)", Array.isArray(tail) && tail.length === 0);
  store.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
