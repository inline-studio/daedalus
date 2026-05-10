// Smoke test for time-awareness wiring.
//   1. nowContext / formatGap return sensible strings
//   2. composeSystemPrompt always appends "# Now" when timeAware is on
//   3. session-gap markers materialize when a stale session is resumed

import { nowContext, formatGap } from "../dist/brain/now.js";
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

// 3. composeSystemPrompt appends Now when timeAware
const config = loadConfig("examples/daedalus.config.yaml");
const { manifest, body } = await loadAgent(config.brain.path, "coder");
const promptOn = await composeSystemPrompt({
  brainPath: config.brain.path,
  agent: manifest,
  agentBody: body,
  skills: [],
});
expect("timeAware=true → '# Now' present", promptOn.includes("# Now"));
expect("timeAware=true → ends with Now",   promptOn.lastIndexOf("# Now") > promptOn.lastIndexOf("# Agent"));

// timeAware=false skips the section
const offManifest = { ...manifest, timeAware: false };
const promptOff = await composeSystemPrompt({
  brainPath: config.brain.path,
  agent: offManifest,
  agentBody: body,
  skills: [],
});
expect("timeAware=false → no '# Now'", !promptOff.includes("# Now"));

// With a sessionGap, "Time since last message" is included
const promptGap = await composeSystemPrompt({
  brainPath: config.brain.path,
  agent: manifest,
  agentBody: body,
  skills: [],
  sessionGapMs: 3 * 86_400_000 + 4 * 3_600_000, // 3d4h
});
expect("sessionGapMs surfaced in Now", /Time since last message in this session: 3 days 4 hours/.test(promptGap));

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
