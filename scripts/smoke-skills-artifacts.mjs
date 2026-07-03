// Smoke test for the Skills & Tools and Artifacts panels: the skill lifecycle helpers
// (pin/unpin/archive), the /skills + /skills/action routes against a real tmp brain,
// and the /artifacts list + ownership-checked download.

import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSkillPinned, archiveSkill, listPendingSkills } from "../dist/tools/skill-manage.js";
import { loadSkill, listSkills } from "../dist/brain/skills.js";
import { WebChannel } from "../dist/channels/web.js";
import { SessionStore } from "../dist/sessions/store.js";
import { AttachmentStore } from "../dist/attachments/store.js";
import { AttachmentIndexStore } from "../dist/attachments/index-store.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const brain = mkdtempSync(join(tmpdir(), "dae-smoke-sa-brain-"));
const mk = async (name, fm) => {
  await fs.mkdir(join(brain, "skills", name), { recursive: true });
  await fs.writeFile(join(brain, "skills", name, "SKILL.md"), `---\n${fm}\n---\nBody\n`);
};
await mk("human-skill", "description: hand written");
await mk("agent-skill", "description: learned\norigin: agent");
await fs.mkdir(join(brain, "skills", ".pending", "fresh-idea"), { recursive: true });
await fs.writeFile(
  join(brain, "skills", ".pending", "fresh-idea", "SKILL.md"),
  "---\ndescription: staged by the review pass\norigin: agent\n---\nBody\n",
);

// --- 1. Lifecycle helpers ---
{
  await setSkillPinned(brain, "agent-skill", true);
  expect("setSkillPinned writes frontmatter", (await loadSkill(brain, "agent-skill"))?.manifest.pinned === true);
  let pinnedRefused = false;
  try {
    await archiveSkill(brain, "agent-skill");
  } catch {
    pinnedRefused = true;
  }
  expect("archive refuses a pinned skill", pinnedRefused);
  await setSkillPinned(brain, "agent-skill", false);
  let humanRefused = false;
  try {
    await archiveSkill(brain, "human-skill");
  } catch {
    humanRefused = true;
  }
  expect("archive refuses a human-authored skill", humanRefused);
}

// --- 2. Routes over HTTP (providers mirroring serve's wiring) ---
const dir = mkdtempSync(join(tmpdir(), "dae-smoke-sa-"));
const sessions = new SessionStore(join(dir, "sessions.sqlite"));
const attachments = new AttachmentStore(join(dir, "attachments"));
const index = new AttachmentIndexStore(join(dir, "sessions.sqlite"));
const PORT = 18796;
const base = `http://127.0.0.1:${PORT}`;

const chan = new WebChannel({
  defaultAgent: "artemis",
  port: PORT,
  sessions,
  heartbeatMs: 60_000,
  skillsProvider: {
    list: async () => {
      const names = await listSkills(brain);
      const skills = [];
      for (const n of names) {
        const s = await loadSkill(brain, n);
        if (s) skills.push({ name: n, description: s.manifest.description, origin: s.manifest.origin, status: s.manifest.status, pinned: s.manifest.pinned });
      }
      return { skills, pending: await listPendingSkills(brain), writable: true };
    },
    action: async (name, action) => {
      try {
        if (action === "pin") await setSkillPinned(brain, name, true);
        else if (action === "archive") await archiveSkill(brain, name);
        else if (action === "reject") {
          const sm = await import("../dist/tools/skill-manage.js");
          await sm.rejectPendingSkill(brain, name);
        } else return { ok: false, error: "unsupported in smoke" };
        return { ok: true };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    },
  },
  artifactsProvider: {
    list: async (userId, q) => (q ? index.search(userId, q, 50) : index.recent(userId, 50)),
    read: async (userId, ref) => {
      const meta = index.getByRef(userId, ref);
      if (!meta) return null;
      const data = await attachments.readBuffer(ref);
      return data ? { data, mediaType: meta.mediaType, filename: meta.filename ?? undefined } : null;
    },
  },
});
await chan.start({ publish: async () => {} });

{
  const j = await fetch(`${base}/skills`).then((r) => r.json());
  expect("GET /skills lists library + pending + writable", j.skills?.length === 2 && j.pending?.length === 1 && j.writable === true, JSON.stringify(j.pending));

  const pin = await fetch(`${base}/skills/action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "agent-skill", action: "pin" }),
  }).then((r) => r.json());
  expect("POST /skills/action pin succeeds", pin.ok === true);

  const rej = await fetch(`${base}/skills/action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "fresh-idea", action: "reject" }),
  }).then((r) => r.json());
  expect("POST /skills/action reject clears the pending entry", rej.ok === true && (await listPendingSkills(brain)).length === 0);

  const bad = await fetch(`${base}/skills/action`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "human-skill", action: "archive" }),
  }).then((r) => r.json());
  expect("action errors surface as ok:false", bad.ok === false && /human/.test(bad.error ?? ""));
}

// --- 3. Artifacts: list + ownership-checked download ---
{
  const meta = await attachments.putBuffer(Buffer.from("artifact bytes here"), "text/plain", "notes.txt");
  const owner = sessions.resolveUser("web", "owner-user");
  index.record({ userId: owner, ref: meta.ref, filename: "notes.txt", mediaType: "text/plain", bytes: 19 });

  const list = await fetch(`${base}/artifacts?externalUserId=owner-user`).then((r) => r.json());
  expect("GET /artifacts lists the user's files", list.files?.length === 1 && list.files[0].filename === "notes.txt");

  const search = await fetch(`${base}/artifacts?externalUserId=owner-user&q=zzz`).then((r) => r.json());
  expect("artifact search filters", search.files?.length === 0);

  const dl = await fetch(`${base}/artifacts/file?externalUserId=owner-user&ref=${encodeURIComponent(meta.ref)}`);
  const bytes = await dl.text();
  expect("download streams the bytes with the right type", dl.status === 200 && bytes === "artifact bytes here" && (dl.headers.get("content-type") || "").startsWith("text/plain"));

  const foreign = await fetch(`${base}/artifacts/file?externalUserId=other-user&ref=${encodeURIComponent(meta.ref)}`);
  expect("another user's ref request is refused", foreign.status === 404);
}

await chan.stop();
sessions.close();
index.close();
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
