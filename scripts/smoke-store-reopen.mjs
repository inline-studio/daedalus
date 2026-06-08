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
//
// Note on inodes: many filesystems (ext4, the GitHub Actions ubuntu runner
// included) reuse inode numbers immediately after unlink. We do NOT assert on
// "inode changed" because the kernel can — and often does — hand back the
// same numeric inode after delete+recreate. The behaviour we actually care
// about is that the write succeeds + the row is queryable from the recreated
// file, which is what the rest of this case checks.
{
  const dir = mkdtempSync(join(tmpdir(), "dae-store-reopen-"));
  const dbPath = join(dir, "sessions.sqlite");
  const store = new SessionStore(dbPath);
  const userId1 = store.resolveUser("cli", "alice");

  // Replace the file: unlink + the next write will trigger ensureFreshConnection,
  // which sees the file is missing and reopens (creating a fresh db).
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
      `got: ${err.message}`,
    );
  }
  if (!errored) {
    expect(
      "SessionStore: dbPath exists again on disk (store recreated it)",
      statSync(dbPath).size > 0,
    );
    expect(
      "SessionStore: new write returned a valid user id",
      typeof userId2 === "string" && userId2.length > 0,
    );
    // Round-trip: the new user-id should resolve to the same value (proving
    // the write landed in the live file the next read sees, not the deleted
    // one our fd used to point at).
    expect(
      "SessionStore: round-trip — second resolveUser returns the same id",
      store.resolveUser("cli", "bob") === userId2,
    );
    // The pre-replace user_id is GONE — expected behaviour, the file we
    // wrote it to was deleted. Just confirm we don't see it.
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
    channel: "telegram",
    userExternalId: "8724271796",
    prompt: "first",
    dueAt: new Date(Date.now() + 60_000).toISOString(),
  });
  unlinkSync(dbPath);
  let row;
  try {
    row = store.enqueue({
      agentName: "artemis",
      createdByAgent: "artemis",
      channel: "telegram",
      userExternalId: "8724271796",
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
