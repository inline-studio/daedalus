import type { ArtemisConfig } from "../config/schema.js";
import type { LLMProvider } from "../providers/base.js";
import type { Message } from "../types.js";
import type { ToolContext, ToolImpl } from "../tools/base.js";
import { buildSkillManageTool } from "../tools/skill-manage.js";
import { renderTurnTranscript } from "../memory/auto-save.js";
import { Kernel } from "../kernel/agent.js";
import { loadSkill, listSkills } from "./skills.js";
import { log } from "../log.js";

// The skill-review pass: the learning half of skill self-learning (the Hermes-agent
// pattern). After a substantial top-level turn, a small fork replays the turn's transcript
// against a reviewer prompt with exactly ONE tool — skill_manage — and lets it patch or
// create skills. Complementary to memory auto-save the way procedures are complementary to
// facts: durable facts about the user go to memory; workflows, fixes, and corrections
// become skills.
//
// Everything here is best-effort and non-fatal: a failure never breaks the user's turn.

export interface SkillReviewTrigger {
  // tool_use parts the main turn produced.
  toolCalls: number;
  // Whether load_skill ran this turn (a loaded skill that proved wrong is the
  // highest-value patch signal — always worth a review).
  skillLoaded: boolean;
  // Accumulated tool calls in this session since skill_manage last ran (the cross-turn
  // nudge counter, already including this turn).
  nudgeTotal: number;
}

// Run the review only when the turn plausibly produced a learning: enough tool activity,
// a skill in play, or the session-level backstop crossed. Trivial turns skip the extra call.
export function shouldRunSkillReview(
  cfg: { minToolCalls: number; nudgeInterval: number },
  t: SkillReviewTrigger,
): boolean {
  return t.toolCalls >= cfg.minToolCalls || t.skillLoaded || t.nudgeTotal >= cfg.nudgeInterval;
}

const REVIEW_SYSTEM = [
  "You are the skill curator for a personal AI assistant. You are shown the assistant's",
  "current skill library and ONE completed turn of conversation, including its tool",
  "activity. Decide whether this turn produced anything worth keeping as a skill — then do",
  "it with the skill_manage tool. You are writing instructions to the assistant's future",
  "self.",
  "",
  "Skill-worthy signals:",
  "- A non-trivial workflow that took several steps or attempts to get right.",
  "- A tricky error and the fix that actually worked.",
  "- A user correction about HOW work should be done (style, process, tool choice) — this",
  "  is a FIRST-CLASS signal; capture it.",
  "- A skill that was loaded this turn and proved wrong, incomplete, or outdated. Patch it",
  "  NOW — an unmaintained skill is a liability.",
  "",
  "Rules:",
  "- Prefer, in this order: (1) patch a skill that was used this turn, (2) patch an",
  "  existing related skill, (3) append_reference to add a support file to one, (4) only",
  "  then create a NEW skill.",
  "- New skills must be CLASS-LEVEL — a reusable procedure family (e.g.",
  "  'provisioning-do-droplets'), never a one-session diary entry. Session-specific names",
  "  are forbidden.",
  "- A skill body says: when to reach for it, the steps, the pitfalls. The description",
  "  must say WHEN to use it — it's all the assistant sees until it loads the body.",
  "- Durable facts about the user belong in memory (handled elsewhere), not in skills.",
  "  Procedures and workflows belong here.",
  "- NEVER persist environment-transient failures ('the registry was down') or negative",
  "  tool claims ('X doesn't work') — these harden into false refusals the assistant will",
  "  cite against itself for months.",
  "- Quality over activity: if the turn was routine, or the library already covers it,",
  "  do nothing. An empty pass is fine; a junk skill is not.",
  "",
  "When you have finished (or decided there is nothing to save), reply with one short",
  "line describing what you did. You are not talking to the user.",
].join("\n");

export interface SkillReviewDeps {
  config: ArtemisConfig;
  provider: LLMProvider;
  // Final model string for the review call (skills.learning.model override, else the
  // agent's own model — same model rides the warm prompt cache).
  model: string;
  // This turn's messages: the trigger + everything the kernel produced.
  messages: Message[];
  // The main turn's tool context — skill_manage reads brainPath/brainWritable/agentName.
  toolContext: ToolContext;
}

export interface SkillReviewResult {
  ran: boolean;
  // skill_manage invocations that succeeded (writes or list calls).
  actions: number;
  // Whether any WRITE action ran (create/patch/append_reference/archive) — the caller
  // resets the session nudge counter on this.
  wrote: boolean;
}

// One-line library summary so the reviewer patches instead of duplicating.
async function renderSkillLibrary(brainPath: string): Promise<string> {
  const names = await listSkills(brainPath);
  if (!names.length) return "(the skill library is empty)";
  const lines: string[] = [];
  for (const n of names) {
    const s = await loadSkill(brainPath, n);
    if (!s) continue;
    const marks = [
      s.manifest.origin === "agent" ? "agent-created" : "",
      s.manifest.status === "stale" ? "stale" : "",
    ]
      .filter(Boolean)
      .join(", ");
    lines.push(`- ${n}${marks ? ` [${marks}]` : ""} — ${s.manifest.description || "(no description)"}`);
  }
  return lines.join("\n");
}

export async function runSkillReview(deps: SkillReviewDeps): Promise<SkillReviewResult> {
  const skip: SkillReviewResult = { ran: false, actions: 0, wrote: false };
  const transcript = renderTurnTranscript(deps.messages);
  if (!transcript.trim()) return skip;

  // The reviewer gets exactly one tool. Wrap it to count successful actions and detect
  // writes (a bare `list` doesn't count as learning).
  const inner = buildSkillManageTool(deps.config);
  let actions = 0;
  let wrote = 0;
  const counted: ToolImpl = {
    definition: inner.definition,
    async invoke(input, ctx) {
      const r = await inner.invoke(input, ctx);
      if (!r.isError) {
        actions++;
        if (input.action !== "list") wrote++;
      }
      return r;
    },
  };

  const library = await renderSkillLibrary(deps.config.brain.path);
  const kernel = new Kernel({
    provider: deps.provider,
    model: deps.model,
    system: REVIEW_SYSTEM,
    builtinTools: [counted],
    mcpServers: new Map(),
    toolContext: deps.toolContext,
    maxTurns: deps.config.skills.learning.maxReviewTurns,
    maxTokens: 4096,
    temperature: 0,
  });

  try {
    const result = await kernel.run(
      `Current skill library:\n${library}\n\nThe turn to review:\n\n${transcript}`,
    );
    log.info(
      { agent: deps.toolContext.agentName, actions, wrote, summary: truncate(result.finalText, 200) },
      "skill-review: pass complete",
    );
    return { ran: true, actions, wrote: wrote > 0 };
  } catch (err) {
    log.warn({ err: (err as Error).message }, "skill-review: pass failed (ignored)");
    return { ran: true, actions, wrote: wrote > 0 };
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}
