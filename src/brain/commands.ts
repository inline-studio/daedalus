import fs from "node:fs/promises";
import path from "node:path";
import { parseFrontmatter } from "./frontmatter.js";
import { z } from "zod";

// Slash-commands ("/ship", "/standup", …) — single-file prompt templates the
// user can invoke from chat. Stored at <brain>/commands/<name>.md. Frontmatter
// is optional; a body-only file is fine.
//
// Frontmatter shape (all optional):
//   description: one-line shown in the agent's system-prompt menu
//   aliases: extra names the user can use ("/s" → /ship)
//
// Manifest opt-in: an agent only sees commands when its manifest declares
// `commands: ['*']` (all) or `commands: ['ship', 'standup']` (subset).
// Default for omitted is no commands. Subagents typically don't get any.
//
// Runtime behaviour: when a user message starts with `/<word>`, the ingest
// step checks the orchestrator's loaded commands for a match; if found, the
// command body is prepended to the inbound message as a system-style preamble
// before the kernel runs.

export const CommandManifestSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  aliases: z.array(z.string()).default([]),
});
export type CommandManifest = z.infer<typeof CommandManifestSchema>;

export interface LoadedCommand {
  manifest: CommandManifest;
  body: string;
}

export async function loadCommand(brainPath: string, name: string): Promise<LoadedCommand | null> {
  const file = path.join(brainPath, "commands", `${name}.md`);
  try {
    const text = await fs.readFile(file, "utf8");
    const fm = parseFrontmatter(text);
    const manifest = CommandManifestSchema.parse({ ...(fm.data as object), name });
    return { manifest, body: fm.content.trim() };
  } catch {
    return null;
  }
}

export async function listCommandNames(brainPath: string): Promise<string[]> {
  const dir = path.join(brainPath, "commands");
  try {
    const files = await fs.readdir(dir);
    return files
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}

// Resolve the agent's declared `commands:` list (which may be `['*']`) against
// the brain's command directory. Returns the LoadedCommand[] the system prompt
// + ingest should consider.
//
// `declared`:
//   undefined / []  → no commands available to this agent (subagent default)
//   ['*']           → all commands found in <brain>/commands/
//   [names…]        → that subset; unknown names logged + skipped
export async function loadAgentCommands(
  brainPath: string,
  declared: string[] | undefined,
): Promise<LoadedCommand[]> {
  if (!declared || declared.length === 0) return [];
  const wanted = declared.includes("*") ? await listCommandNames(brainPath) : declared;
  const loaded: LoadedCommand[] = [];
  for (const name of wanted) {
    const c = await loadCommand(brainPath, name);
    if (c) loaded.push(c);
  }
  return loaded;
}

// Detect a leading slash-command in user input. Matches the first word if it
// starts with "/" and consists of letters / digits / hyphens / underscores.
// Returns the matched command + the remainder of the input ("/ship now" →
// { name: "ship", rest: "now" }), or null if no slash-command at the start.
export function detectSlashCommand(text: string): { name: string; rest: string } | null {
  if (!text) return null;
  const m = text.match(/^\s*\/([A-Za-z0-9_-]+)(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), rest: m[2] ?? "" };
}

// Resolve a command name (or alias) against the loaded commands.
export function resolveCommand(
  commands: LoadedCommand[],
  name: string,
): LoadedCommand | null {
  const lower = name.toLowerCase();
  return (
    commands.find((c) => c.manifest.name.toLowerCase() === lower) ??
    commands.find((c) => c.manifest.aliases.some((a) => a.toLowerCase() === lower)) ??
    null
  );
}
