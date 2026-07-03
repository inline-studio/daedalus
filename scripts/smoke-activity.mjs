// Smoke test for the live activity view: the registry, the activity labels, the
// dispatcher decorator (registers/updates/ends, skips subagents, passes abort through),
// and the GET /activity route's per-user scoping.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActivityRegistry,
  activityLabel,
  withActivityTracking,
} from "../dist/kernel/activity.js";
import { WebChannel } from "../dist/channels/web.js";
import { SessionStore } from "../dist/sessions/store.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// --- 1. Registry basics ---
{
  const reg = new ActivityRegistry();
  reg.start({ conversationId: "c1", userId: "u1", agent: "artemis", channel: "web", startedAt: "2026-07-03T10:00:00Z", activity: "working" });
  reg.start({ conversationId: "c2", userId: "u2", agent: "artemis", channel: "telegram", startedAt: "2026-07-03T10:01:00Z", activity: "working" });
  reg.update("c1", "tool: bash");
  expect("listForUser scopes to the user", reg.listForUser("u1").length === 1 && reg.listForUser("u1")[0].activity === "tool: bash");
  reg.end("c1");
  expect("end removes the turn", reg.listForUser("u1").length === 0 && reg.size() === 1);
}

// --- 2. Activity labels ---
{
  expect("tool label", activityLabel({ type: "tool_use", id: "t", name: "bash", input: {} }) === "tool: bash");
  expect(
    "tool label carries the telling input field",
    activityLabel({ type: "tool_use", id: "t", name: "web_fetch", input: { url: "https://php.net/manual" } }) ===
      "tool: web_fetch — https://php.net/manual",
  );
  expect(
    "subagent tool label carries the chain",
    activityLabel({ type: "tool_use", id: "t", name: "read", input: {}, origin: { path: ["cypher"], spawnId: "s" } }) === "cypher · tool: read",
  );
  expect("thinking label", activityLabel({ type: "thinking_delta", text: "…" }) === "thinking");
  expect("tool_running adds nothing (tool_use already announced it)", activityLabel({ type: "tool_running", id: "t", name: "bash" }) === null);
  expect("failed tool_result is called out", activityLabel({ type: "tool_result", id: "t", name: "bash", isError: true }) === "tool failed: bash");
  expect("ok tool_result stays quiet", activityLabel({ type: "tool_result", id: "t", name: "bash", isError: false }) === null);
  expect("spawn label", activityLabel({ type: "subagent_start", prompt: "x", origin: { path: ["cypher"], spawnId: "s" } }) === "spawning cypher");
  expect("origin turn_complete is ignored", activityLabel({ type: "turn_complete", finalText: "", origin: { path: ["cypher"], spawnId: "s" } }) === null);
}

// --- 2b. The flowing log: accumulation, dedup, coalescing ---
{
  const reg = new ActivityRegistry();
  reg.start({ conversationId: "c1", userId: "u1", agent: "artemis", channel: "web", startedAt: "2026-07-03T10:00:00Z", activity: "working" });
  reg.update("c1", "thinking — what is", "think:0");
  reg.update("c1", "thinking — what is the best approach", "think:0"); // same segment → refine in place
  reg.update("c1", "tool: web_fetch — php.net");
  reg.update("c1", "tool: web_fetch — php.net"); // exact repeat → ignored
  reg.update("c1", "thinking — ok, array_values then", "think:1"); // new segment → new entry
  const t = reg.listForUser("u1")[0];
  expect(
    "log accumulates one entry per step (coalesced thinking, deduped repeats)",
    t.log.length === 3 &&
      t.log[0].label === "thinking — what is the best approach" &&
      t.log[1].label === "tool: web_fetch — php.net" &&
      t.log[2].label === "thinking — ok, array_values then",
    JSON.stringify(t.log.map((e) => e.label)),
  );
  expect("activity mirrors the newest step", t.activity === "thinking — ok, array_values then");
}

// --- 3. Dispatcher decorator ---
{
  const reg = new ActivityRegistry();
  let midDispatchTurns = null;
  let sawSink = null;
  let midDispatchLog = null;
  const inner = {
    id: "stub",
    streaming: true,
    async dispatch(args) {
      sawSink = args.onEvent;
      args.onEvent?.({ type: "thinking_delta", text: "weighing the " });
      args.onEvent?.({ type: "thinking_delta", text: "two options" });
      args.onEvent?.({ type: "tool_use", id: "t1", name: "web_fetch", input: {} });
      midDispatchTurns = reg.listForUser("u1").map((t) => t.activity);
      midDispatchLog = reg.listForUser("u1")[0]?.log.map((e) => e.label);
      return { status: "complete", finalText: "ok", turns: 1 };
    },
    async abort(sessionId) {
      return sessionId === "c9";
    },
  };
  const wrapped = withActivityTracking(inner, reg);
  expect("wrapper preserves id + streaming", wrapped.id === "stub" && wrapped.streaming === true);

  const events = [];
  await wrapped.dispatch({
    agentName: "artemis", sessionId: "c9", userId: "u1", isSubagent: false,
    originChannel: "web", onEvent: (ev) => events.push(ev),
  });
  expect("turn registered + live label mid-dispatch", JSON.stringify(midDispatchTurns) === '["tool: web_fetch"]', JSON.stringify(midDispatchTurns));
  expect(
    "wrapper coalesces thinking deltas into one snippet entry before the tool step",
    Array.isArray(midDispatchLog) && midDispatchLog.length === 2 &&
      midDispatchLog[0] === "thinking — weighing the two options" && midDispatchLog[1] === "tool: web_fetch",
    JSON.stringify(midDispatchLog),
  );
  expect("caller sink still receives events", events.length === 3 && events[2].type === "tool_use");
  expect("turn removed after dispatch", reg.size() === 0);
  expect("abort passes through", (await wrapped.abort("c9")) === true);

  // A buffered dispatch (no caller sink) still gets a tracking sink.
  sawSink = null;
  await wrapped.dispatch({ agentName: "artemis", sessionId: "c10", userId: "u1", isSubagent: false });
  expect("tracking sink injected even without a caller sink", typeof sawSink === "function");

  // Subagent dispatches are not tracked.
  let subMid = null;
  const inner2 = {
    id: "stub",
    async dispatch() {
      subMid = reg.size();
      return { status: "complete", finalText: "ok", turns: 1 };
    },
  };
  await withActivityTracking(inner2, reg).dispatch({ agentName: "cypher", sessionId: "c11", userId: "u1", isSubagent: true });
  expect("subagent dispatch is not registered", subMid === 0);
}

// --- 4. GET /activity: per-user scoping over HTTP ---
{
  const dir = mkdtempSync(join(tmpdir(), "dae-smoke-activity-"));
  const sessions = new SessionStore(join(dir, "sessions.sqlite"));
  const PORT = 18795;
  const reg = new ActivityRegistry();
  const chan = new WebChannel({
    defaultAgent: "artemis",
    port: PORT,
    sessions,
    heartbeatMs: 60_000,
    listActivity: async (userId) => reg.listForUser(userId),
  });
  await chan.start({ publish: async () => {} });
  const base = `http://127.0.0.1:${PORT}`;

  const uid1 = sessions.resolveUser("web", "user-one");
  const uid2 = sessions.resolveUser("web", "user-two");
  reg.start({ conversationId: "a", userId: uid1, agent: "artemis", channel: "web", startedAt: new Date().toISOString(), activity: "tool: bash" });
  reg.start({ conversationId: "b", userId: uid2, agent: "artemis", channel: "telegram", startedAt: new Date().toISOString(), activity: "thinking" });

  const mine = await fetch(`${base}/activity?externalUserId=user-one`).then((r) => r.json());
  expect("GET /activity returns only the caller's turns", mine.turns?.length === 1 && mine.turns[0].activity === "tool: bash", JSON.stringify(mine));
  const theirs = await fetch(`${base}/activity?externalUserId=user-two`).then((r) => r.json());
  expect("other users see their own", theirs.turns?.length === 1 && theirs.turns[0].channel === "telegram");

  await chan.stop();
  sessions.close();
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
