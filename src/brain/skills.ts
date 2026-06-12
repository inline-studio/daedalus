import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { assertUnderBrain } from "./safe-path.js";
import { SkillManifestSchema, type SkillManifest } from "../config/schema.js";

export interface LoadedSkill {
  manifest: SkillManifest;
  body: string;
  rootPath: string; // skill directory
}

export async function loadSkill(
  brainPath: string,
  skillName: string,
): Promise<LoadedSkill | null> {
  const root = path.join(brainPath, "skills", skillName);
  const skillFile = path.join(root, "SKILL.md");
  try {
    assertUnderBrain(brainPath, root);
    const text = await fs.readFile(skillFile, "utf8");
    const fm = parseFrontmatter(text);
    const manifest = SkillManifestSchema.parse({ ...(fm.data as object), name: skillName });
    return { manifest, body: fm.content.trim(), rootPath: root };
  } catch {
    return null;
  }
}

// A trigger phrase from a skill manifest that matched a user message.
export interface SkillTriggerMatch {
  skill: string;
  trigger: string;
}

// Lowercase, strip punctuation except intra-word apostrophes ("i'm leaving"),
// collapse runs of whitespace. Applied to both the message and the trigger so
// "Good night!" matches the declared phrase "good night".
function normalizeForTrigger(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .trim();
}

// Match a message against the trigger phrases declared by the given skills.
// A trigger matches when its normalized phrase appears as a whole-word sequence
// anywhere in the normalized message. At most one match is reported per skill.
export function matchSkillTriggers(text: string, skills: SkillManifest[]): SkillTriggerMatch[] {
  const haystack = ` ${normalizeForTrigger(text)} `;
  const out: SkillTriggerMatch[] = [];
  for (const skill of skills) {
    for (const trigger of skill.triggers) {
      const needle = normalizeForTrigger(trigger);
      if (needle && haystack.includes(` ${needle} `)) {
        out.push({ skill: skill.name, trigger });
        break;
      }
    }
  }
  return out;
}

export async function listSkills(brainPath: string): Promise<string[]> {
  const dir = path.join(brainPath, "skills");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const out: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        await fs.access(path.join(dir, e.name, "SKILL.md"));
        out.push(e.name);
      } catch {
        /* not a skill dir */
      }
    }
    return out;
  } catch {
    return [];
  }
}
