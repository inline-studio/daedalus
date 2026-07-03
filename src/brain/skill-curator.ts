import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import matter from "gray-matter";
import { parseFrontmatter } from "./frontmatter.js";
import { assertUnderBrain } from "./safe-path.js";
import { loadSkill, listSkills } from "./skills.js";
import type { SkillLearningStore } from "../sessions/skill-learning-store.js";
import { log } from "../log.js";

// The staleness curator: deterministic lifecycle maintenance for AGENT-CREATED skills.
// No LLM involved — pure age math on the usage tracker (falling back to the SKILL.md
// mtime for skills that have never been loaded since learning was enabled):
//
//   unused ≥ staleAfterDays   → frontmatter `status: stale` (demoted in the skill menu)
//   unused ≥ archiveAfterDays → the whole directory moves to skills/.archive/<name>-<date>
//
// Never deletes; never touches human-authored skills (`origin` ≠ agent) or pinned ones.
// A stale skill that gets used or patched again comes back: load_skill bumps the usage
// row, and skill_manage's patch resets `status: active`.

export interface CuratorOptions {
  brainPath: string;
  store: SkillLearningStore;
  staleAfterDays: number;
  archiveAfterDays: number;
}

export interface CuratorResult {
  checked: number;
  markedStale: string[];
  archived: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export async function runSkillCurator(opts: CuratorOptions): Promise<CuratorResult> {
  const result: CuratorResult = { checked: 0, markedStale: [], archived: [] };
  const now = Date.now();

  for (const name of await listSkills(opts.brainPath)) {
    const skill = await loadSkill(opts.brainPath, name);
    if (!skill) continue;
    if (skill.manifest.origin !== "agent" || skill.manifest.pinned) continue;
    result.checked++;

    const skillFile = path.join(skill.rootPath, "SKILL.md");
    let lastActive: number;
    const used = opts.store.lastUsed(name);
    if (used) {
      lastActive = Date.parse(used);
    } else {
      // Never loaded since tracking began — age from the file's last write (a fresh or
      // freshly-patched skill isn't "unused for months" just because nobody loaded it yet).
      try {
        lastActive = (await fs.stat(skillFile)).mtimeMs;
      } catch {
        continue;
      }
    }
    if (!Number.isFinite(lastActive)) continue;
    const idleDays = (now - lastActive) / DAY_MS;

    try {
      if (idleDays >= opts.archiveAfterDays) {
        const dest = path.join(
          opts.brainPath,
          "skills",
          ".archive",
          `${name}-${new Date(now).toISOString().slice(0, 10)}`,
        );
        assertUnderBrain(opts.brainPath, dest);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.rename(skill.rootPath, dest);
        result.archived.push(name);
      } else if (idleDays >= opts.staleAfterDays && skill.manifest.status !== "stale") {
        const fm = parseFrontmatter(await fs.readFile(skillFile, "utf8"));
        const text = matter.stringify(fm.content, { ...(fm.data as object), status: "stale" });
        await fs.writeFile(skillFile, text, "utf8");
        result.markedStale.push(name);
      }
    } catch (err) {
      log.warn({ skill: name, err: (err as Error).message }, "skill-curator: transition failed (skipped)");
    }
  }

  if (result.markedStale.length || result.archived.length) {
    await commitCuratorSweep(opts.brainPath, result);
    log.info(
      { stale: result.markedStale, archived: result.archived, checked: result.checked },
      "skill-curator: sweep complete",
    );
  }
  return result;
}

// Best-effort commit, same contract as skill_manage's: a failed commit never undoes a sweep.
async function commitCuratorSweep(brainPath: string, r: CuratorResult): Promise<void> {
  try {
    await fs.access(path.join(brainPath, ".git"));
  } catch {
    return;
  }
  try {
    const parts: string[] = [];
    if (r.markedStale.length) parts.push(`mark stale: ${r.markedStale.join(", ")}`);
    if (r.archived.length) parts.push(`archive: ${r.archived.join(", ")}`);
    await execa("git", ["-C", brainPath, "add", "-A", "skills"], { timeout: 10_000 });
    await execa(
      "git",
      ["-C", brainPath, "-c", "user.name=daedalus", "-c", "user.email=daedalus@local", "commit", "-m", `skills: curator sweep — ${parts.join("; ")}`],
      { timeout: 10_000 },
    );
  } catch (err) {
    log.warn({ err: (err as Error).message }, "skill-curator: brain git commit failed (ignored)");
  }
}
