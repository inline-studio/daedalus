import type { ToolImpl } from "./base.js";
import type { LoadedSkill } from "../brain/skills.js";

// Progressive skill disclosure. The system prompt carries only a one-line MENU of
// each skill (name + description) — not the full SKILL.md body — so the per-turn
// baseline stays small even for an orchestrator with many/large skills. When the
// agent decides it needs a skill, it calls `load_skill(name)` and the full body
// comes back as a tool_result. That body then lives in the conversation history
// (subject to the usual context-window trimming) for the rest of the session, so a
// skill is read at most once per session — the same read-on-demand pattern the brain
// already uses for its per-stack coding standards.
// `onLoad` (optional) is called with the skill name on every successful load — the
// skill-learning usage tracker hangs off it so the staleness curator knows what's alive.
export function buildLoadSkillTool(
  skills: LoadedSkill[],
  onLoad?: (skill: string) => void,
): ToolImpl {
  const byName = new Map(skills.map((s) => [s.manifest.name, s]));
  const names = [...byName.keys()];
  return {
    definition: {
      name: "load_skill",
      description:
        "Load the full instructions for one of your available skills (listed in the " +
        "Skills section of your system prompt). Returns the skill's complete body. Call " +
        "this BEFORE using a skill — the system prompt only lists the names + summaries, " +
        "not the instructions. " +
        "Skills are CLIs / instruction sets YOU drive yourself: load_skill → bash. They are " +
        "NOT subagents — don't try to invoke them with spawn_subagent (that's for AI peers " +
        "like cypher). If a name is listed here, it's a skill; use load_skill + bash. " +
        `Available skills: ${names.length ? names.join(", ") : "(none)"}.`,
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "The skill name to load, exactly as shown in the Skills menu.",
            ...(names.length ? { enum: names } : {}),
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
    },
    async invoke(input) {
      const name = String(input.name ?? "").trim();
      if (!name) {
        return { content: "load_skill requires a 'name'.", isError: true };
      }
      const skill = byName.get(name);
      if (!skill) {
        return {
          content: `Unknown skill '${name}'. Available skills: ${
            names.length ? names.join(", ") : "(none)"
          }.`,
          isError: true,
        };
      }
      try {
        onLoad?.(name);
      } catch {
        /* usage tracking must never break a load */
      }
      if (!skill.body) {
        return { content: `Skill '${name}' has no instructions body.` };
      }
      return { content: `# Skill: ${name}\n\n${skill.body}` };
    },
  };
}
