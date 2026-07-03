import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import matter from "gray-matter";
import type { ToolImpl, ToolContext } from "./base.js";
import type { ArtemisConfig } from "../config/schema.js";
import { SkillManifestSchema } from "../config/schema.js";
import { parseFrontmatter } from "../brain/frontmatter.js";
import { assertUnderBrain } from "../brain/safe-path.js";
import { loadSkill, listSkills } from "../brain/skills.js";
import { log } from "../log.js";

// `skill_manage` — the write side of skill self-learning. The post-turn review pass (and an
// orchestrator that's been given the tool) uses it to create, patch, extend, and retire
// skills in the brain. Guard rails:
//
//   - refuses outright unless the brain is writable (`brain.writable: true`)
//   - with `skills.learning.writeApproval` (the default), create/patch/append_reference land
//     in skills/.pending/<name>/ for human review (`dae skill pending|approve|reject`)
//     instead of going live
//   - archive never deletes: the skill directory moves to skills/.archive/, recoverable
//   - only agent-created skills (frontmatter `origin: agent`) can be archived by the model;
//     human-authored skills are the operator's to retire
//   - every live write is committed when the brain is a git repo, so learned changes are
//     diffable and revertible
//
// Names are validated (kebab-case), paths are confined to the brain, and the frontmatter we
// write is round-tripped through SkillManifestSchema before touching disk.

const PENDING_DIR = ".pending";
const ARCHIVE_DIR = ".archive";
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,49}$/;
const REF_FILENAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/;

export interface PendingSkill {
  name: string;
  description: string;
  // Whether a live skill of the same name exists (i.e. this pending entry is a patch).
  patchesExisting: boolean;
}

function skillsRoot(brainPath: string): string {
  return path.join(brainPath, "skills");
}

// Serialize a skill to SKILL.md text, validating the manifest shape first.
function renderSkillFile(name: string, data: Record<string, unknown>, body: string): string {
  SkillManifestSchema.parse({ ...data, name });
  return matter.stringify("\n" + body.trim() + "\n", data);
}

async function readSkillAt(dir: string): Promise<{ data: Record<string, unknown>; body: string } | null> {
  try {
    const fm = parseFrontmatter(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"));
    return { data: fm.data as Record<string, unknown>, body: fm.content.trim() };
  } catch {
    return null;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// Best-effort commit of a live skill write when the brain is a git repo. Never throws —
// a failed commit (no git binary, dirty index elsewhere, ownership quirks in-container)
// must not undo a successful skill write.
async function commitBrainChange(brainPath: string, message: string): Promise<void> {
  try {
    if (!(await exists(path.join(brainPath, ".git")))) return;
    await execa("git", ["-C", brainPath, "add", "-A", "skills"], { timeout: 10_000 });
    await execa(
      "git",
      ["-C", brainPath, "-c", "user.name=daedalus", "-c", "user.email=daedalus@local", "commit", "-m", message],
      { timeout: 10_000 },
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, "skill_manage: brain git commit failed (ignored)");
  }
}

// --- Pending-queue helpers (shared with the `dae skill` CLI) ---

export async function listPendingSkills(brainPath: string): Promise<PendingSkill[]> {
  const root = path.join(skillsRoot(brainPath), PENDING_DIR);
  let entries: string[];
  try {
    entries = (await fs.readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
  const out: PendingSkill[] = [];
  for (const name of entries.sort()) {
    const read = await readSkillAt(path.join(root, name));
    if (!read) continue;
    out.push({
      name,
      description: String(read.data.description ?? ""),
      patchesExisting: await exists(path.join(skillsRoot(brainPath), name, "SKILL.md")),
    });
  }
  return out;
}

// Promote a staged skill to live: move (overwrite) the pending directory over skills/<name>.
export async function approvePendingSkill(brainPath: string, name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`invalid skill name '${name}'`);
  const from = path.join(skillsRoot(brainPath), PENDING_DIR, name);
  const to = path.join(skillsRoot(brainPath), name);
  assertUnderBrain(brainPath, from);
  assertUnderBrain(brainPath, to);
  if (!(await exists(path.join(from, "SKILL.md")))) {
    throw new Error(`no pending skill '${name}'`);
  }
  // A pending patch replaces the live skill wholesale (the staged copy is the full
  // post-patch skill, not a diff) — but any live-only extras (references/, bootstrap.sh)
  // must survive, so merge: copy staged files over the live dir, then drop the staging.
  await fs.mkdir(to, { recursive: true });
  await fs.cp(from, to, { recursive: true, force: true });
  await fs.rm(from, { recursive: true, force: true });
  await commitBrainChange(brainPath, `skill(${name}): approve pending version`);
}

export async function rejectPendingSkill(brainPath: string, name: string): Promise<void> {
  if (!NAME_RE.test(name)) throw new Error(`invalid skill name '${name}'`);
  const from = path.join(skillsRoot(brainPath), PENDING_DIR, name);
  assertUnderBrain(brainPath, from);
  if (!(await exists(path.join(from, "SKILL.md")))) {
    throw new Error(`no pending skill '${name}'`);
  }
  await fs.rm(from, { recursive: true, force: true });
}

// --- The tool ---

export function buildSkillManageTool(config: ArtemisConfig): ToolImpl {
  const approval = config.skills.learning.writeApproval;
  return {
    definition: {
      name: "skill_manage",
      description:
        `Create, patch, extend, list, or archive the skills in your brain — this is how you ` +
        `LEARN. After completing a complex task (5+ tool calls), fixing a tricky error, or ` +
        `discovering a non-trivial workflow, save the approach as a skill so you can reuse it. ` +
        `When a skill you loaded proved outdated or wrong, patch it immediately.\n\n` +
        `Prefer, in order: (1) patching a skill you loaded this session, (2) patching an ` +
        `existing related skill, (3) append_reference to add a support file to one, (4) only ` +
        `then creating a NEW class-level skill. Skills are procedures and workflows — durable ` +
        `facts about the user belong in memory, not here. Never persist environment-transient ` +
        `failures ("X was down") or negative tool claims ("Y doesn't work") — these harden ` +
        `into false refusals.` +
        (approval
          ? `\n\nWrites are STAGED for human approval (dae skill pending) — they do not go ` +
            `live until approved, so write freely when the learning is real.`
          : ""),
      inputSchema: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["create", "patch", "append_reference", "list", "archive"],
          },
          name: {
            type: "string",
            description: "Skill name, kebab-case (e.g. 'deploy-checklist'). Required except for list.",
          },
          description: {
            type: "string",
            description:
              "One-line summary shown in the skill menu — it must clearly say WHEN to reach " +
              "for the skill. Required on create; optional on patch.",
          },
          body: {
            type: "string",
            description:
              "The full SKILL.md body (markdown instructions to your future self). Required on " +
              "create; on patch, replaces the existing body.",
          },
          append_body: {
            type: "string",
            description: "On patch: append this to the existing body instead of replacing it.",
          },
          triggers: {
            type: "array",
            items: { type: "string" },
            description: "Optional plain phrases that deterministically surface the skill.",
          },
          filename: {
            type: "string",
            description: "append_reference: file name under the skill's references/ directory.",
          },
          content: {
            type: "string",
            description: "append_reference: the reference file's content.",
          },
        },
        required: ["action"],
        additionalProperties: false,
      },
    },

    async invoke(input, ctx: ToolContext) {
      const action = String(input.action ?? "");
      const brainPath = ctx.brainPath;

      if (action === "list") {
        const names = await listSkills(brainPath);
        const lines: string[] = [];
        for (const n of names) {
          const s = await loadSkill(brainPath, n);
          if (!s) continue;
          const flags = [
            s.manifest.origin === "agent" ? "agent-created" : "",
            s.manifest.status === "stale" ? "stale" : "",
            s.manifest.pinned ? "pinned" : "",
          ]
            .filter(Boolean)
            .join(", ");
          lines.push(`- ${n}${flags ? ` [${flags}]` : ""} — ${s.manifest.description || "(no description)"}`);
        }
        const pending = await listPendingSkills(brainPath);
        if (pending.length) {
          lines.push("", "Pending human approval (not live):");
          for (const p of pending) lines.push(`- ${p.name}${p.patchesExisting ? " (patch)" : " (new)"} — ${p.description}`);
        }
        return { content: lines.length ? lines.join("\n") : "(no skills)" };
      }

      if (!ctx.brainWritable) {
        return {
          content:
            "The brain is mounted read-only (brain.writable is false) — skills can't be " +
            "changed from here. Tell the user what you wanted to save instead.",
          isError: true,
        };
      }

      const name = String(input.name ?? "").trim();
      if (!NAME_RE.test(name)) {
        return {
          content: `Invalid skill name '${name}' — use kebab-case: lowercase letters, digits, hyphens (max 50 chars).`,
          isError: true,
        };
      }
      const liveDir = path.join(skillsRoot(brainPath), name);
      const targetDir = approval ? path.join(skillsRoot(brainPath), PENDING_DIR, name) : liveDir;
      assertUnderBrain(brainPath, liveDir);
      assertUnderBrain(brainPath, targetDir);
      const staged = approval ? " Staged for human approval — it is NOT live until approved." : "";

      switch (action) {
        case "create": {
          const description = String(input.description ?? "").trim();
          const body = String(input.body ?? "").trim();
          if (!description || !body) {
            return { content: "create requires both 'description' and 'body'.", isError: true };
          }
          if (await exists(path.join(liveDir, "SKILL.md"))) {
            return {
              content: `Skill '${name}' already exists — use action: "patch" to improve it instead of recreating it.`,
              isError: true,
            };
          }
          const data: Record<string, unknown> = {
            description,
            version: "0.1.0",
            origin: "agent",
            ...(Array.isArray(input.triggers) && input.triggers.length
              ? { triggers: input.triggers.map(String) }
              : {}),
          };
          let text: string;
          try {
            text = renderSkillFile(name, data, body);
          } catch (err) {
            return { content: `Skill manifest failed validation: ${(err as Error).message}`, isError: true };
          }
          await fs.mkdir(targetDir, { recursive: true });
          await fs.writeFile(path.join(targetDir, "SKILL.md"), text, "utf8");
          if (!approval) await commitBrainChange(brainPath, `skill(${name}): create (by ${ctx.agentName})`);
          log.info({ skill: name, agent: ctx.agentName, staged: approval }, "skill_manage: created");
          return { content: `Created skill '${name}'.${staged}` };
        }

        case "patch": {
          // Patch works from the freshest copy: a still-pending version if one exists,
          // else the live skill. The staged result is always the FULL post-patch skill.
          const base = (await readSkillAt(targetDir)) ?? (await readSkillAt(liveDir));
          if (!base) {
            return {
              content: `Skill '${name}' doesn't exist — use action: "create" for a new skill.`,
              isError: true,
            };
          }
          const description = String(input.description ?? "").trim();
          const body = String(input.body ?? "").trim();
          const appendBody = String(input.append_body ?? "").trim();
          if (!description && !body && !appendBody) {
            return { content: "patch needs 'description', 'body', or 'append_body'.", isError: true };
          }
          if (body && appendBody) {
            return { content: "pass either 'body' (replace) or 'append_body' (extend), not both.", isError: true };
          }
          const newBody = body || (appendBody ? `${base.body}\n\n${appendBody}` : base.body);
          const data: Record<string, unknown> = {
            ...base.data,
            ...(description ? { description } : {}),
            // A patched skill is being maintained — clear any curator staleness flag.
            status: "active",
          };
          let text: string;
          try {
            text = renderSkillFile(name, data, newBody);
          } catch (err) {
            return { content: `Skill manifest failed validation: ${(err as Error).message}`, isError: true };
          }
          await fs.mkdir(targetDir, { recursive: true });
          await fs.writeFile(path.join(targetDir, "SKILL.md"), text, "utf8");
          if (!approval) await commitBrainChange(brainPath, `skill(${name}): patch (by ${ctx.agentName})`);
          log.info({ skill: name, agent: ctx.agentName, staged: approval }, "skill_manage: patched");
          return { content: `Patched skill '${name}'.${staged}` };
        }

        case "append_reference": {
          const filename = String(input.filename ?? "").trim();
          const content = String(input.content ?? "");
          if (!REF_FILENAME_RE.test(filename)) {
            return {
              content: `Invalid reference filename '${filename}' — plain file names only (letters, digits, . _ -).`,
              isError: true,
            };
          }
          if (!content.trim()) {
            return { content: "append_reference requires non-empty 'content'.", isError: true };
          }
          if (!(await readSkillAt(targetDir)) && !(await readSkillAt(liveDir))) {
            return { content: `Skill '${name}' doesn't exist — create it first.`, isError: true };
          }
          const refDir = path.join(targetDir, "references");
          assertUnderBrain(brainPath, path.join(refDir, filename));
          await fs.mkdir(refDir, { recursive: true });
          await fs.writeFile(path.join(refDir, filename), content, "utf8");
          if (!approval) {
            await commitBrainChange(brainPath, `skill(${name}): add reference ${filename} (by ${ctx.agentName})`);
          }
          log.info({ skill: name, file: filename, staged: approval }, "skill_manage: reference added");
          return { content: `Added references/${filename} to skill '${name}'.${staged}` };
        }

        case "archive": {
          if (approval) {
            return {
              content:
                "Archiving is handled by the staleness curator and the operator while write " +
                "approval is on — leave the skill in place.",
              isError: true,
            };
          }
          const live = await loadSkill(brainPath, name);
          if (!live) {
            return { content: `Skill '${name}' doesn't exist.`, isError: true };
          }
          if (live.manifest.pinned) {
            return { content: `Skill '${name}' is pinned — it can't be archived.`, isError: true };
          }
          if (live.manifest.origin !== "agent") {
            return {
              content: `Skill '${name}' is human-authored — only the operator retires those.`,
              isError: true,
            };
          }
          const dest = path.join(
            skillsRoot(brainPath),
            ARCHIVE_DIR,
            `${name}-${new Date().toISOString().slice(0, 10)}`,
          );
          assertUnderBrain(brainPath, dest);
          await fs.mkdir(path.dirname(dest), { recursive: true });
          await fs.rename(liveDir, dest);
          await commitBrainChange(brainPath, `skill(${name}): archive (by ${ctx.agentName})`);
          log.info({ skill: name, dest }, "skill_manage: archived");
          return { content: `Archived skill '${name}' (recoverable under skills/.archive/).` };
        }

        default:
          return { content: `Unknown action '${action}'.`, isError: true };
      }
    },
  };
}
