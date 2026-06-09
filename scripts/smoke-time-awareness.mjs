// Smoke test for time-awareness wiring.
//   1. nowContext / formatGap return sensible strings
//   2. composeSystemPrompt is time-INVARIANT (no "# Now") — the system prefix stays
//      byte-stable so the inference backend can reuse its KV cache across requests
//   3. appendNowToLastUserMessage rides the time context on the latest user turn instead
//   4. session-gap markers materialize when a stale session is resumed

import { nowContext, formatGap, appendNowToLastUserMessage } from "../dist/brain/now.js";
import { composeSystemPrompt } from "../dist/brain/composer.js";
import { loadConfig } from "../dist/config/load.js";
import { loadAgent } from "../dist/brain/agents.js";
import { SessionStore } from "../dist/sessions/store.js";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. formatGap covers boundaries
expect("formatGap < 1 min",   formatGap(30_000)            === "less than a minute");
expect("formatGap minutes",   formatGap(15 * 60_000)       === "15 minutes");
expect("formatGap hour exact",formatGap(3600_000)          === "1 hour");
expect("formatGap hour+min",  formatGap(90 * 60_000)       === "1 hour 30 minutes");
expect("formatGap day",       formatGap(86_400_000)        === "1 day");
expect("formatGap days+hrs",  formatGap(3 * 86_400_000 + 4 * 3_600_000) === "3 days 4 hours");

// 2. nowContext shape
const now = nowContext();
expect("now contains '# Now'", now.includes("# Now"));
expect("now mentions ISO datetime", /Current date\/time \(UTC\):/.test(now));
expect("now mentions day of week", /Day of the week:/.test(now));

// 3. composeSystemPrompt is time-invariant — "# Now" must NOT be baked into the system
//    prompt (it changes every request and would cold-prefill the whole prompt). True whether
//    or not the agent is time-aware; the time context rides on the user turn instead.
const config = loadConfig("examples/daedalus.config.yaml");
const { manifest, body } = await loadAgent(config.brain.path, "coder");
const prompt = await composeSystemPrompt({
  brainPath: config.brain.path,
  agent: manifest,
  agentBody: body,
  skills: [],
});
expect("system prompt is time-invariant (no '# Now')", !prompt.includes("# Now"));
const offManifest = { ...manifest, timeAware: false };
const promptOff = await composeSystemPrompt({
  brainPath: config.brain.path,
  agent: offManifest,
  agentBody: body,
  skills: [],
});
expect("system prompt time-invariant regardless of timeAware", !promptOff.includes("# Now"));

// 3b. appendNowToLastUserMessage rides the time context on the latest user turn.
const msgs = [
  { role: "assistant", content: [{ type: "text", text: "earlier reply" }] },
  { role: "user", content: [{ type: "text", text: "hello" }] },
];
appendNowToLastUserMessage(msgs, { timeAware: true });
expect("appendNow → '# Now' on last user turn", msgs[1].content.some((p) => p.type === "text" && p.text.includes("# Now")));
expect("appendNow → array length unchanged", msgs.length === 2);
expect("appendNow → earlier turn untouched", !JSON.stringify(msgs[0]).includes("# Now"));

// no-op when not time-aware
const offMsgs = [{ role: "user", content: [{ type: "text", text: "hi" }] }];
appendNowToLastUserMessage(offMsgs, { timeAware: false });
expect("appendNow timeAware=false → no-op", !JSON.stringify(offMsgs).includes("# Now"));

// no-op when the last message isn't a user turn
const asstLast = [
  { role: "user", content: [{ type: "text", text: "q" }] },
  { role: "assistant", content: [{ type: "text", text: "a" }] },
];
appendNowToLastUserMessage(asstLast, { timeAware: true });
expect("appendNow last≠user → no-op", !JSON.stringify(asstLast).includes("# Now"));

// doesn't mutate the original message object (transient; never persisted)
const orig = { role: "user", content: [{ type: "text", text: "hello" }] };
const arr = [orig];
appendNowToLastUserMessage(arr, { timeAware: true });
expect("appendNow → original message object untouched", orig.content.length === 1 && arr[0] !== orig);

// 4. Session-resume marker via the SessionStore: insert an old message, verify next-load detects it
const tmpDir = path.join(os.tmpdir(), `dae-time-smoke-${Date.now()}`);
await fs.mkdir(tmpDir, { recursive: true });
const dbPath = path.join(tmpDir, "sessions.sqlite");
const store = new SessionStore(dbPath);
const userId = store.resolveUser("cli", "test-user");
const session = store.getOrCreateSession(userId, "coder");
store.appendMessage({ sessionId: session.id, role: "user", content: [{ type: "text", text: "hello from 3 days ago" }] });

// Backdate that row using the underlying DB. Open a second connection via better DatabaseSync.
import { DatabaseSync } from "node:sqlite";
const db = new DatabaseSync(dbPath);
const threeDaysAgo = new Date(Date.now() - 3 * 86_400_000).toISOString();
db.prepare("UPDATE messages SET created_at = ? WHERE session_id = ?").run(threeDaysAgo, session.id);
db.close();

const tail = store.tail(session.id, 1);
const last = tail[tail.length - 1];
const gap = Date.now() - new Date(last.createdAt).getTime();
const wouldMark = gap >= 60 * 60_000;
expect("3-day-old tail computes >= 1h gap", wouldMark, `gap=${formatGap(gap)}`);
store.close();
await fs.rm(tmpDir, { recursive: true });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
