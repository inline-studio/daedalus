import fs from "node:fs/promises";
import path from "node:path";
import type { AgentManifest } from "../config/schema.js";
import type { LoadedSkill } from "./skills.js";
import type { LoadedCommand } from "./commands.js";

// Read every *.md from `dir`, optionally filtered to a list of names (without .md).
// Names compare against the basename. An empty filter list means "include all".
async function readMdSection(
  brainPath: string,
  dir: string,
  filter: string[] | undefined,
): Promise<string[]> {
  const root = path.join(brainPath, dir);
  let files: string[];
  try {
    files = (await fs.readdir(root)).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const want = filter && filter.length > 0 ? new Set(filter) : null;
  const out: string[] = [];
  for (const f of files) {
    const name = f.replace(/\.md$/, "");
    if (want && !want.has(name)) continue;
    out.push((await fs.readFile(path.join(root, f), "utf8")).trim());
  }
  return out;
}

export interface ComposerInput {
  brainPath: string;
  agent: AgentManifest;
  agentBody: string;
  skills: LoadedSkill[];
  // Slash-commands available to this agent (already filtered per the
  // manifest's `commands:` list). When non-empty, a "Commands" section is
  // injected into the system prompt with names + descriptions so the agent
  // knows what to expect when the user types /word.
  commands?: LoadedCommand[];
  // Orchestrator identity. Injected so every agent knows what name the user is addressing.
  // Subagents see this too so they can refer to "Artemis" internally without breaking the
  // single-persona illusion.
  identity?: { name: string; nickname?: string };
  // Whether this agent is operating as a subagent (called via spawn_subagent). Drives a
  // special instructions block about question-bubbling rather than answering the user
  // directly.
  isSubagent?: boolean;
}

// Deterministic order: identity → standards → operations → souls → personas → skills →
// commands → agent body. The system prompt is intentionally time-INVARIANT: the "# Now"
// time context is NOT composed here. It's appended to the latest user message at turn
// assembly (see agent-turn) so this whole prefix stays byte-identical across turns and the
// backend can reuse its KV cache instead of re-prefilling on every request.
export async function composeSystemPrompt(input: ComposerInput): Promise<string> {
  const { brainPath, agent, agentBody, skills } = input;

  const standards = await readMdSection(brainPath, "standards", agent.standards);
  const operations = await readMdSection(brainPath, "operations", agent.operations);
  const souls = await readMdSection(brainPath, "souls", agent.souls.length ? agent.souls : undefined);
  const personas = await readMdSection(
    brainPath,
    "personas",
    agent.personas.length ? agent.personas : undefined,
  );

  const parts: string[] = [];
  if (input.identity) parts.push(identitySection(input.identity, Boolean(input.isSubagent)));
  if (standards.length) parts.push(section("Standards", standards));
  if (operations.length) parts.push(section("Operations", operations));
  if (souls.length) parts.push(section("Soul", souls));
  if (personas.length) parts.push(section("Persona", personas));
  if (skills.length) parts.push(section("Skills", [skillMenu(skills)]));
  // Brain-defined commands expand into a preamble before the message reaches the agent;
  // built-ins (currently /compact) are handled by the supervisor and never reach it. Both
  // are listed so the agent can answer "what commands are available?". Subagents skip the
  // built-ins — channel-level commands don't apply to them.
  const commandLines = (input.commands ?? []).map((c) => {
    const aliases = c.manifest.aliases.length ? ` (alias: ${c.manifest.aliases.join(", ")})` : "";
    const desc = c.manifest.description ? ` — ${c.manifest.description}` : "";
    return `- \`/${c.manifest.name}\`${aliases}${desc}`;
  });
  if (commandLines.length || !input.isSubagent) {
    const blocks: string[] = [];
    if (commandLines.length) {
      blocks.push(
        `When the user's message starts with one of these, the command body is prepended ` +
          `as a system-style preamble before their message reaches you:\n\n${commandLines.join("\n")}`,
      );
    }
    if (!input.isSubagent) {
      blocks.push(
        `Built-in, handled by the supervisor before a message reaches you:\n\n` +
          `- \`/compact\` — summarises the conversation so far; later turns continue from the summary`,
      );
    }
    parts.push(section("Commands", blocks));
  }
  if (agentBody) parts.push(section("Agent", [agentBody]));

  return parts.join("\n\n---\n\n");
}

function identitySection(identity: { name: string; nickname?: string }, isSubagent: boolean): string {
  if (isSubagent) {
    return [
      `# Identity`,
      ``,
      `You are working as an internal specialist, called by **${identity.name}** — the user-facing`,
      `assistant. The user does NOT know you exist as a separate agent. From their perspective,`,
      `${identity.name} is the only thing answering them.`,
      ``,
      `Rules:`,
      `- Don't address the user as if they're talking to you. They aren't.`,
      `- Return concise, factual results to ${identity.name}; ${identity.name} will phrase them for the user.`,
      `- If you need information from the user, call the \`ask_user\` tool with a clear, single`,
      `  question. ${identity.name} will surface it; their reply will arrive in your next prompt.`,
      `- Don't say "I" in a way that implies the user is your direct interlocutor.`,
    ].join("\n");
  }
  const nickHint = identity.nickname && identity.nickname !== identity.name
    ? ` Some users may call you "${identity.nickname}".`
    : "";
  return [
    `# Identity`,
    ``,
    `You are **${identity.name}**.${nickHint} You are the single user-facing assistant —`,
    `everything the user sees comes through you, in your voice. When you delegate work to`,
    `internal specialists (via \`spawn_subagent\`), the user is unaware of them; their`,
    `outputs and questions flow through you and appear as your own.`,
    ``,
    `When a subagent's response surfaces a pending question (a \`PENDING_QUESTION:\` marker`,
    `or similar), don't expose the subagent's name — phrase the question as your own and`,
    `wait for the user's reply. When the user answers, route the answer back to the same`,
    `subagent via \`spawn_subagent\` so they can resume.`,
  ].join("\n");
}

function section(title: string, items: string[]): string {
  return `# ${title}\n\n${items.join("\n\n")}`;
}

// Progressive disclosure: list each skill by name + one-line description rather than
// inlining the full SKILL.md body. The full body is fetched on demand via the
// `load_skill` tool. This keeps the per-turn system prompt small even for an agent
// with many or large skills — the bodies are only spent when a skill is actually used.
function skillMenu(skills: LoadedSkill[]): string {
  const lines = skills.map((s) => {
    const desc = s.manifest.description ? ` — ${s.manifest.description}` : "";
    return `- **${s.manifest.name}**${desc}`;
  });
  return [
    "These skills are available to you. Only the name and a one-line summary are shown here —",
    "the full instructions are NOT loaded. When a task calls for a skill, call",
    "`load_skill({ name })` to read its complete instructions BEFORE you use it; the body then",
    "stays in this conversation for the rest of the session, so you load each skill at most once.",
    "",
    lines.join("\n"),
  ].join("\n");
}
