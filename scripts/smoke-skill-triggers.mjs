// Smoke for skill trigger phrases (`triggers:` in SKILL.md frontmatter).
//
// Exercises the matcher directly, then runs a message through ingest against a
// fake brain to confirm the trigger preamble lands ahead of the user text in
// the persisted message — and that slash-commands and plain chat don't get one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchSkillTriggers, loadSkill } from "../dist/brain/skills.js";
import { ingestIncomingMessage } from "../dist/kernel/ingest.js";
import { SessionStore } from "../dist/sessions/store.js";
import { AttachmentStore } from "../dist/attachments/store.js";
import { NoopTranscriber } from "../dist/attachments/transcribe.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dae-skill-triggers-"));
const brainRoot = path.join(tmp, "brain");
fs.mkdirSync(path.join(brainRoot, "agents"), { recursive: true });
fs.mkdirSync(path.join(brainRoot, "skills", "home-assistant"), { recursive: true });
fs.mkdirSync(path.join(brainRoot, "skills", "no-triggers"), { recursive: true });

fs.writeFileSync(
  path.join(brainRoot, "skills", "home-assistant", "SKILL.md"),
  `---
description: Control the house.
triggers: ["good night", "go dark", "i'm leaving"]
---

Forward the request to HA.
`,
);
fs.writeFileSync(
  path.join(brainRoot, "skills", "no-triggers", "SKILL.md"),
  `---
description: A skill without triggers.
---

Body.
`,
);
fs.writeFileSync(
  path.join(brainRoot, "agents", "artemis.md"),
  `---
description: test agent
provider: anthropic
model: claude-sonnet-4-6
skills: ['*']
---

You are a test agent.
`,
);

// 1. The matcher: normalization, word boundaries, one match per skill.
{
  const ha = await loadSkill(brainRoot, "home-assistant", false);
  const none = await loadSkill(brainRoot, "no-triggers", false);
  const skills = [ha.manifest, none.manifest];
  const m = (text) => matchSkillTriggers(text, skills);

  expect("exact phrase matches", m("good night")[0]?.trigger === "good night");
  expect("case + punctuation insensitive", m("Good night!")[0]?.trigger === "good night");
  expect("phrase inside a longer message matches", m("ok good night then").length === 1);
  expect("apostrophe phrase matches", m("I'm leaving now")[0]?.trigger === "i'm leaving");
  expect("partial word does not match", m("goodnight").length === 0);
  expect("substring inside a word does not match", m("the nightgown is good").length === 0);
  expect("unrelated text does not match", m("what's the weather?").length === 0);
  expect(
    "at most one match per skill",
    m("good night and go dark").length === 1,
  );
}

// 2. Ingest: the preamble lands before the user text on a trigger match.
const sessions = new SessionStore(path.join(tmp, "sessions.sqlite"));
const attachments = new AttachmentStore(path.join(tmp, "attachments"));
await attachments.ensureDir();
const config = { brain: { path: brainRoot } };

const ingest = async (uid, text) => {
  const res = await ingestIncomingMessage({
    agentName: "artemis",
    incoming: { channel: "web", externalUserId: uid, text },
    sessions,
    attachments,
    transcriber: new NoopTranscriber(),
    config,
  });
  const tail = sessions.tail(res.sessionId, 10);
  return tail[tail.length - 1].content.filter((c) => c.type === "text").map((c) => c.text);
};

{
  const parts = await ingest("u1", "good night artemis");
  expect("trigger message gets two text parts", parts.length === 2, `got ${parts.length}`);
  expect(
    "preamble names the skill and trigger",
    /skill trigger matched/.test(parts[0]) &&
      parts[0].includes("home-assistant") &&
      parts[0].includes('"good night"'),
    parts[0]?.slice(0, 90),
  );
  expect("user text is preserved verbatim", parts[1] === "good night artemis");
}

{
  const parts = await ingest("u2", "how are you today?");
  expect("plain chat gets no preamble", parts.length === 1 && parts[0] === "how are you today?");
}

{
  const parts = await ingest("u3", "/ship good night");
  expect(
    "slash-command input skips trigger detection",
    parts.every((t) => !/skill trigger matched/.test(t)),
  );
}

sessions.close();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
