// Smoke test for runtime scheduling: ScheduleStore + parseWhen + the
// schedule_message/cancel/list tools. Doesn't drive the supervisor poll loop
// end-to-end (that'd need a real dispatcher + session DB seeded with an agent
// manifest) — just exercises the in-process pieces.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ScheduleStore } from "../dist/sessions/schedule-store.js";
import { parseWhen, nextCronFire } from "../dist/scheduler/parse-when.js";
import {
  scheduleMessageTool,
  cancelScheduledMessageTool,
  listScheduledMessagesTool,
} from "../dist/tools/schedule.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const dir = mkdtempSync(join(tmpdir(), "dae-sched-"));
const dbPath = join(dir, "test.sqlite");
const store = new ScheduleStore(dbPath);

// --- parseWhen ----------------------------------------------------------------
{
  const now = new Date("2026-05-18T10:00:00Z");

  const rel = parseWhen("in 30 minutes", now);
  expect(
    "parseWhen('in 30 minutes') = +30min, no cron",
    rel.dueAt === "2026-05-18T10:30:00.000Z" && !rel.cron,
    `dueAt=${rel.dueAt} cron=${rel.cron}`,
  );

  const hr = parseWhen("in 2 hours", now);
  expect(
    "parseWhen('in 2 hours') = +2h, no cron",
    hr.dueAt === "2026-05-18T12:00:00.000Z" && !hr.cron,
    `dueAt=${hr.dueAt}`,
  );

  const iso = parseWhen("2026-05-19T10:00:00Z", now);
  expect(
    "parseWhen(ISO future) = that ISO, no cron",
    iso.dueAt === "2026-05-19T10:00:00.000Z" && !iso.cron,
    `dueAt=${iso.dueAt}`,
  );

  let threwOnPast = false;
  try {
    parseWhen("2020-01-01T00:00:00Z", now);
  } catch {
    threwOnPast = true;
  }
  expect("parseWhen(ISO past) throws", threwOnPast);

  const cron = parseWhen("*/10 * * * *", now);
  expect(
    "parseWhen(cron */10) = first fire in future + cron preserved",
    !!cron.cron && cron.cron === "*/10 * * * *" && new Date(cron.dueAt) > now,
    `dueAt=${cron.dueAt} cron=${cron.cron}`,
  );

  const next = nextCronFire("*/10 * * * *", new Date("2026-05-18T10:05:00Z"));
  expect(
    "nextCronFire(*/10) after 10:05 = 10:10",
    next === "2026-05-18T10:10:00.000Z",
    `got ${next}`,
  );

  let threw = false;
  try {
    parseWhen("not-a-time", now);
  } catch {
    threw = true;
  }
  expect("parseWhen(garbage) throws", threw);
}

// --- ScheduleStore CRUD -------------------------------------------------------
{
  const row = store.enqueue({
    agentName: "artemis",
    createdByAgent: "artemis",
    channel: "telegram",
    userExternalId: "8724271796",
    prompt: "ping me",
    dueAt: new Date(Date.now() - 1000).toISOString(), // already due
  });
  expect("enqueue returns a row with id", !!row.id && row.status === "pending");
  expect(
    "enqueue persists the origin channel + external id (not the sched id)",
    row.channel === "telegram" && row.userExternalId === "8724271796" && row.userExternalId !== row.id,
    `channel=${row.channel} userExternalId=${row.userExternalId}`,
  );

  const got = store.get(row.id);
  expect("get returns the row", got?.id === row.id && got?.channel === "telegram");

  // Not-due row — claimDue should not return it
  store.enqueue({
    agentName: "artemis",
    createdByAgent: "artemis",
    channel: "telegram",
    userExternalId: "8724271796",
    prompt: "later",
    dueAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  const due = store.claimDue();
  expect(
    "claimDue returns only past-due rows",
    due.length === 1 && due[0].id === row.id,
    `got ${due.length} rows`,
  );
  expect("claimDue flipped row status to 'firing'", store.get(row.id)?.status === "firing");

  store.markFired(row.id);
  const after = store.get(row.id);
  expect(
    "markFired sets done + fire_count=1 + last_fired_at",
    after?.status === "done" && after?.fireCount === 1 && !!after?.lastFiredAt,
  );

  const recurring = store.enqueue({
    agentName: "artemis",
    createdByAgent: "artemis",
    channel: "telegram",
    userExternalId: "8724271796",
    prompt: "tick",
    dueAt: new Date(Date.now() - 1000).toISOString(),
    recurringCron: "*/5 * * * *",
  });
  store.claimDue();
  const nextDue = new Date(Date.now() + 5 * 60_000).toISOString();
  store.reschedule(recurring.id, nextDue);
  const rec = store.get(recurring.id);
  expect(
    "reschedule resets to pending with new due_at and bumps fire_count",
    rec?.status === "pending" && rec?.dueAt === nextDue && rec?.fireCount === 1,
  );

  // Cancellation is creator-scoped
  const owned = store.enqueue({
    agentName: "artemis",
    createdByAgent: "artemis",
    channel: "telegram",
    userExternalId: "8724271796",
    prompt: "owned",
    dueAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  expect("cancel by wrong agent returns false", store.cancel(owned.id, "intruder") === false);
  expect("owned row still pending after wrong-agent cancel", store.get(owned.id)?.status === "pending");
  expect("cancel by creator returns true", store.cancel(owned.id, "artemis") === true);
  expect("owned row now cancelled", store.get(owned.id)?.status === "cancelled");
}

// --- Tools (schedule_message / cancel / list) ---------------------------------
{
  const schedTool = scheduleMessageTool(store);
  const ctx = {
    agentName: "orchestrator",
    brainPath: "/tmp",
    brainWritable: false,
    workspacePath: "/tmp",
    runtime: { id: "host" },
    originChannel: "telegram",
    originExternalUserId: "8724271796",
  };

  const r = await schedTool.invoke({ when: "in 1 hour", prompt: "remind me" }, ctx);
  expect("schedule_message tool returns id in content", !r.isError && /id=sched_/.test(r.content));
  // The core fix: the armed row carries the originating channel + external id from
  // ctx, NOT the synthetic schedule id (the orphan-session bug).
  {
    const id = r.content.match(/id=(sched_\w+)/)[1];
    const stored = store.get(id);
    expect(
      "armed row routes to the origin channel + external id (not the sched id)",
      stored?.channel === "telegram" &&
        stored?.userExternalId === "8724271796" &&
        stored?.userExternalId !== id,
      `channel=${stored?.channel} userExternalId=${stored?.userExternalId}`,
    );
  }

  // Without an origin identity the tool must refuse rather than arm a misrouting row.
  const noOrigin = await schedTool.invoke(
    { when: "in 1 hour", prompt: "remind me" },
    { agentName: "orchestrator", brainPath: "/tmp", brainWritable: false, workspacePath: "/tmp", runtime: { id: "host" } },
  );
  expect("schedule_message refuses without origin identity", noOrigin.isError === true);

  const bad = await schedTool.invoke({ when: "garbage", prompt: "x" }, ctx);
  expect("schedule_message tool reports parse error", bad.isError === true);

  const empty = await schedTool.invoke({ when: "in 5 minutes", prompt: "   " }, ctx);
  expect("schedule_message tool rejects empty prompt", empty.isError === true);

  // Cancel: only the creator can cancel
  const mine = await schedTool.invoke({ when: "in 1 hour", prompt: "mine" }, ctx);
  const mineId = mine.content.match(/id=(sched_\w+)/)[1];
  const cancelTool = cancelScheduledMessageTool(store);
  const wrong = await cancelTool.invoke({ id: mineId }, { ...ctx, agentName: "imposter" });
  expect("cancel from another agent fails", wrong.isError === true);
  const right = await cancelTool.invoke({ id: mineId }, ctx);
  expect("cancel from creator succeeds", !right.isError && /cancelled/.test(right.content));

  const listTool = listScheduledMessagesTool(store);
  const list = await listTool.invoke({}, ctx);
  expect(
    "list returns the orchestrator's active schedules only",
    !list.isError && /sched_/.test(list.content),
    list.content.slice(0, 200),
  );
}

store.close();
rmSync(dir, { recursive: true, force: true });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
