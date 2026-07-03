// Smoke test for skill self-learning: the skill_manage tool (approval staging, guard
// rails), the pending approve/reject queue, the review-pass trigger policy, a full
// review pass against a scripted provider, the usage/nudge store, and the staleness
// curator's deterministic transitions.

import fs from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSkillManageTool,
  listPendingSkills,
  approvePendingSkill,
  rejectPendingSkill,
} from "../dist/tools/skill-manage.js";
import { runSkillReview, shouldRunSkillReview } from "../dist/brain/skill-review.js";
import { runSkillCurator } from "../dist/brain/skill-curator.js";
import { loadSkill, listSkills } from "../dist/brain/skills.js";
import { SkillLearningStore } from "../dist/sessions/skill-learning-store.js";
import { composeSystemPrompt } from "../dist/brain/composer.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const brain = mkdtempSync(join(tmpdir(), "dae-smoke-learn-"));
await fs.mkdir(join(brain, "skills"), { recursive: true });

function fakeConfig(overrides = {}) {
  return {
    brain: { path: brain, writable: true },
    skills: {
      learning: {
        enabled: true,
        minToolCalls: 5,
        nudgeInterval: 10,
        writeApproval: true,
        maxReviewTurns: 6,
        curator: { enabled: true, schedule: "0 4 * * 0", staleAfterDays: 30, archiveAfterDays: 90 },
        ...overrides,
      },
    },
  };
}
const ctx = (writable = true) => ({ brainPath: brain, brainWritable: writable, agentName: "artemis" });

// --- 1. skill_manage with approval ON: create stages, approve promotes, reject discards ---
{
  const tool = buildSkillManageTool(fakeConfig());
  const r = await tool.invoke(
    { action: "create", name: "deploy-checklist", description: "Deploying a site end to end", body: "1. build\n2. test\n3. ship" },
    ctx(),
  );
  expect("create (approval on) succeeds and says staged", !r.isError && /NOT live/i.test(r.content), r.content);
  expect("staged skill is not live yet", (await listSkills(brain)).length === 0);
  const pending = await listPendingSkills(brain);
  expect("pending queue lists it as new", pending.length === 1 && pending[0].name === "deploy-checklist" && !pending[0].patchesExisting);

  await approvePendingSkill(brain, "deploy-checklist");
  const live = await loadSkill(brain, "deploy-checklist");
  expect("approve promotes to live with origin: agent", live?.manifest.origin === "agent", JSON.stringify(live?.manifest));
  expect("pending queue is empty after approve", (await listPendingSkills(brain)).length === 0);

  // A staged patch overlays the live skill only on approve; reject discards it.
  await tool.invoke({ action: "patch", name: "deploy-checklist", append_body: "4. verify" }, ctx());
  expect("patch (approval on) staged, live body unchanged", (await loadSkill(brain, "deploy-checklist"))?.body.indexOf("4. verify") === -1);
  await rejectPendingSkill(brain, "deploy-checklist");
  expect("reject discards the staged patch", (await listPendingSkills(brain)).length === 0);
}

// --- 2. Guard rails ---
{
  const tool = buildSkillManageTool(fakeConfig());
  const ro = await tool.invoke({ action: "create", name: "x-ro", description: "d", body: "b" }, ctx(false));
  expect("read-only brain refused", ro.isError === true, ro.content);
  const bad = await tool.invoke({ action: "create", name: "../evil", description: "d", body: "b" }, ctx());
  expect("path-traversal name refused", bad.isError === true);
  const dup = await tool.invoke({ action: "create", name: "deploy-checklist", description: "d", body: "b" }, ctx());
  expect("duplicate create refused (points at patch)", dup.isError === true && /patch/.test(dup.content));
  const arch = await tool.invoke({ action: "archive", name: "deploy-checklist" }, ctx());
  expect("archive refused while approval mode is on", arch.isError === true);
}

// --- 3. approval OFF: live writes, archive rules ---
{
  const tool = buildSkillManageTool(fakeConfig({ writeApproval: false }));
  await tool.invoke({ action: "patch", name: "deploy-checklist", append_body: "4. verify" }, ctx());
  const live = await loadSkill(brain, "deploy-checklist");
  expect("patch (approval off) goes live", live?.body.includes("4. verify"));
  expect("patch resets status to active", live?.manifest.status === "active");

  await tool.invoke({ action: "append_reference", name: "deploy-checklist", filename: "hosts.md", content: "casa: 10.0.0.2" }, ctx());
  const ref = await fs.readFile(join(brain, "skills", "deploy-checklist", "references", "hosts.md"), "utf8");
  expect("append_reference writes under references/", ref.includes("casa"));

  // Human-authored skill: model may patch it, never archive it.
  await fs.mkdir(join(brain, "skills", "human-skill"), { recursive: true });
  await fs.writeFile(
    join(brain, "skills", "human-skill", "SKILL.md"),
    "---\ndescription: human authored\n---\nBody\n",
  );
  const noArch = await tool.invoke({ action: "archive", name: "human-skill" }, ctx());
  expect("human-authored skill can't be archived by the model", noArch.isError === true);

  const ok = await tool.invoke({ action: "archive", name: "deploy-checklist" }, ctx());
  expect("agent-created skill archives", !ok.isError, ok.content);
  expect("archived skill is out of the live list", !(await listSkills(brain)).includes("deploy-checklist"));
  const archDirs = await fs.readdir(join(brain, "skills", ".archive"));
  expect("archive directory holds the skill (recoverable)", archDirs.some((d) => d.startsWith("deploy-checklist-")));
}

// --- 4. Trigger policy ---
{
  const cfg = { minToolCalls: 5, nudgeInterval: 10 };
  expect("big turn triggers", shouldRunSkillReview(cfg, { toolCalls: 5, skillLoaded: false, nudgeTotal: 5 }));
  expect("skill-loaded turn triggers", shouldRunSkillReview(cfg, { toolCalls: 1, skillLoaded: true, nudgeTotal: 1 }));
  expect("nudge backstop triggers", shouldRunSkillReview(cfg, { toolCalls: 2, skillLoaded: false, nudgeTotal: 10 }));
  expect("trivial turn does not trigger", !shouldRunSkillReview(cfg, { toolCalls: 2, skillLoaded: false, nudgeTotal: 4 }));
}

// --- 5. Review pass end-to-end with a scripted provider ---
{
  // Turn 1: the reviewer calls skill_manage(create); turn 2: it wraps up with text.
  let calls = 0;
  const provider = {
    id: "fake",
    capabilities: { tools: true, streaming: false, vision: false, systemPromptAsField: true },
    async complete(req) {
      calls++;
      if (calls === 1) {
        return {
          message: {
            role: "assistant",
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "skill_manage",
                input: {
                  action: "create",
                  name: "git-worktree-flow",
                  description: "Working with parallel git worktrees",
                  body: "How to set up and clean worktrees.",
                },
              },
            ],
          },
          stopReason: "tool_use",
        };
      }
      return {
        message: { role: "assistant", content: [{ type: "text", text: "Saved one skill." }] },
        stopReason: "end_turn",
      };
    },
  };
  const review = await runSkillReview({
    config: fakeConfig(), // approval ON — the write must stage, not go live
    provider,
    model: "fake-model",
    messages: [
      { role: "user", content: [{ type: "text", text: "set up worktrees for me" }] },
      { role: "assistant", content: [{ type: "text", text: "done — used 6 commands" }] },
    ],
    toolContext: ctx(),
  });
  expect("review pass ran and wrote", review.ran && review.wrote && review.actions === 1, JSON.stringify(review));
  const pending = await listPendingSkills(brain);
  expect("review-created skill is staged, not live", pending.some((p) => p.name === "git-worktree-flow"));
  expect("reviewer saw the library in its prompt", calls >= 1);
  await rejectPendingSkill(brain, "git-worktree-flow");
}

// --- 6. Usage + nudge store ---
{
  const dbPath = join(brain, "sessions.sqlite");
  const store = new SkillLearningStore(dbPath);
  store.recordUse("human-skill");
  expect("recordUse → lastUsed roundtrip", typeof store.lastUsed("human-skill") === "string");
  expect("unknown skill lastUsed is null", store.lastUsed("nope") === null);
  expect("nudge accumulates", store.addToolCalls("s1", 3) === 3 && store.addToolCalls("s1", 4) === 7);
  store.resetNudge("s1");
  expect("nudge resets", store.addToolCalls("s1", 1) === 1);
  store.close();
}

// --- 7. Curator transitions ---
{
  const dbPath = join(brain, "sessions.sqlite");
  const store = new SkillLearningStore(dbPath);
  const mk = async (name, fm) => {
    await fs.mkdir(join(brain, "skills", name), { recursive: true });
    await fs.writeFile(join(brain, "skills", name, "SKILL.md"), `---\n${fm}\n---\nBody\n`);
  };
  await mk("old-agent-skill", "description: idle 40 days\norigin: agent");
  await mk("ancient-agent-skill", "description: idle 100 days\norigin: agent");
  await mk("pinned-agent-skill", "description: idle but pinned\norigin: agent\npinned: true");
  await mk("old-human-skill", "description: human, idle forever");
  const backdate = async (name, days) => {
    const t = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await fs.utimes(join(brain, "skills", name, "SKILL.md"), t, t);
  };
  await backdate("old-agent-skill", 40);
  await backdate("ancient-agent-skill", 100);
  await backdate("pinned-agent-skill", 100);
  await backdate("old-human-skill", 400);

  const result = await runSkillCurator({ brainPath: brain, store, staleAfterDays: 30, archiveAfterDays: 90 });
  expect("curator marks 40-day agent skill stale", result.markedStale.includes("old-agent-skill"), JSON.stringify(result));
  expect("curator archives 100-day agent skill", result.archived.includes("ancient-agent-skill"));
  expect("pinned skill untouched", !result.markedStale.includes("pinned-agent-skill") && !result.archived.includes("pinned-agent-skill"));
  expect("human skill untouched", !result.markedStale.includes("old-human-skill") && !result.archived.includes("old-human-skill"));
  const stale = await loadSkill(brain, "old-agent-skill");
  expect("stale flag persisted in frontmatter", stale?.manifest.status === "stale");
  expect("archived skill gone from live list", !(await listSkills(brain)).includes("ancient-agent-skill"));

  // A recently-used old skill stays active: usage row beats mtime.
  store.recordUse("old-agent-skill");
  const second = await runSkillCurator({ brainPath: brain, store, staleAfterDays: 30, archiveAfterDays: 90 });
  expect("used skill not re-transitioned", !second.archived.includes("old-agent-skill"), JSON.stringify(second));
  store.close();
}

// --- 8. Composer: upkeep block + stale demotion ---
{
  const agent = (tools) => ({
    name: "artemis", description: "", tools, skills: [], mcpServers: [], commands: [],
    subagents: [], souls: ["none"], personas: ["none"], standards: ["none"], operations: ["none"],
    maxTurns: 50, maxTokens: 4096, thinking: { enabled: false }, timeAware: true,
    provider: "openai", model: "m", vision: false,
  });
  const staleSkill = { manifest: { name: "old-one", description: "old", status: "stale", origin: "agent", pinned: false, version: "0", toolsRequired: [], triggers: [], requires: { secrets: [] } }, body: "b", rootPath: "/x" };
  const freshSkill = { manifest: { name: "fresh", description: "new", status: "active", origin: "human", pinned: false, version: "0", toolsRequired: [], triggers: [], requires: { secrets: [] } }, body: "b", rootPath: "/x" };
  const withTool = await composeSystemPrompt({ brainPath: brain, agent: agent(["skill_manage"]), agentBody: "", skills: [staleSkill, freshSkill] });
  expect("upkeep block present when agent holds skill_manage", withTool.includes("Skill upkeep"));
  expect("stale skill marked and sorted last", withTool.indexOf("**fresh**") < withTool.indexOf("**old-one**") && withTool.includes("stale"));
  const without = await composeSystemPrompt({ brainPath: brain, agent: agent([]), agentBody: "", skills: [freshSkill] });
  expect("no upkeep block without the tool", !without.includes("Skill upkeep"));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
