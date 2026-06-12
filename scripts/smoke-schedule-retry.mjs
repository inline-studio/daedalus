// BUG-04: a failing scheduled fire must NOT re-fire every poll tick forever. markFailed now
// counts attempts, backs off (pushes due_at forward), and dead-letters after MAX attempts; a
// success resets the counter.

import { ScheduleStore } from "../dist/sessions/schedule-store.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sched-retry-"));
const store = new ScheduleStore(path.join(dir, "s.sqlite"));
const base = { agentName: "a", createdByAgent: "a", channel: "telegram", userExternalId: "1", prompt: "p" };

// --- 1. A persistently-failing one-shot backs off, then dead-letters (not re-claimed) ---
{
  const r = store.enqueue({ ...base, dueAt: new Date(0).toISOString() }); // due in the past
  let asOf = new Date(1000);
  let claimed = store.claimDue(asOf);
  expect("row is claimed initially (→ firing)", claimed.some((x) => x.id === r.id));

  let outcome;
  let rounds = 0;
  for (; rounds < 10; rounds++) {
    outcome = store.markFailed(r.id, asOf);
    if (outcome.deadLettered) break;
    // backoff must push due_at into the future relative to the failure time
    expect(`attempt ${outcome.attempts}: backed off (not immediately due)`, new Date(outcome.nextDueAt) > asOf);
    // not claimable until the backoff elapses
    expect(`attempt ${outcome.attempts}: not re-claimed before backoff`, !store.claimDue(asOf).some((x) => x.id === r.id));
    // advance to the backoff time and re-claim (→ firing) for the next failure
    asOf = new Date(outcome.nextDueAt);
    expect(`attempt ${outcome.attempts}: re-claimed at backoff time`, store.claimDue(asOf).some((x) => x.id === r.id));
  }
  expect("dead-lettered after MAX attempts (5)", outcome.deadLettered && outcome.attempts === 5);
  expect("dead-lettered row is terminal status 'cancelled'", store.get(r.id).status === "cancelled");
  expect(
    "dead-lettered row is never claimed again, even far in the future",
    !store.claimDue(new Date(Date.now() + 365 * 864e5)).some((x) => x.id === r.id),
  );
}

// --- 2. A success resets fire_attempts (a recurring row that recovers isn't penalised) ---
{
  const r = store.enqueue({ ...base, dueAt: new Date(0).toISOString(), recurringCron: "*/10 * * * *" });
  store.claimDue(new Date(1000)); // → firing
  store.markFailed(r.id, new Date(1000)); // attempts = 1
  expect("fire_attempts incremented on failure", store.get(r.id).fireAttempts === 1);
  // simulate a successful fire: claim at the backoff time, then reschedule
  const due = store.get(r.id).dueAt;
  store.claimDue(new Date(due)); // → firing
  store.reschedule(r.id, new Date(Date.now() + 600_000).toISOString());
  expect("fire_attempts reset to 0 after a successful reschedule", store.get(r.id).fireAttempts === 0);
}

store.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
