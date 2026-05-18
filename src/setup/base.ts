import path from "node:path";
import fs from "node:fs/promises";
import prompts from "prompts";
import { upsertEnvFile } from "./env-file.js";
import { editYamlFile, setIn, deleteIn } from "./yaml-edit.js";
import { listAgents } from "../brain/agents.js";
import { loadConfig } from "../config/load.js";
import { buildSecretsBackend } from "../secrets/store/factory.js";
import type { SecretsBackend } from "../secrets/store/base.js";

export interface SetupContext {
  // Path to the daedalus config file the user is targeting (must exist).
  configPath: string;
  // Path to the .env.local where secrets get written. Always relative to configPath's dir.
  envPath: string;
  // Brain path resolved from the config file.
  brainPath: string;
}

export interface DisableOptions {
  // When true, also delete saved secrets and remove all related config keys (clean slate).
  // When false (default), just flip enabled flags so re-enabling is a one-step undo.
  purge: boolean;
  // When true, skip confirmation prompts (for scripts).
  yes: boolean;
}

// Setups can optionally record key outcomes for the step-based wizard summary
// (e.g. "API key saved as ONECLI_API_KEY", "agent 'daedalus' ensured"). When
// run standalone (no wizard shell), this is a no-op.
export interface SetupRunOptions {
  record?: (line: string) => void;
}

export interface ChannelSetup {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  run(ctx: SetupContext, opts?: SetupRunOptions): Promise<void>;
  // Reverse `run`. Optional — setups without a disable flow surface a clear error.
  disable?(ctx: SetupContext, opts: DisableOptions): Promise<void>;
}

// Disable helper: flip a list of YAML toggles to false / new value, optionally purge a list
// of YAML keys + secret names. Always idempotent.
export async function persistChannelDisable(args: {
  configPath: string;
  envPath: string;
  channelId: string;
  // Toggles to set (typically `[…channel, "enabled"]: false`).
  yamlSets: Array<{ keyPath: string[]; value: unknown }>;
  // YAML key paths to delete entirely. Only applied when purge=true.
  yamlPurge: string[][];
  // Secret names to delete from the SecretsBackend. Only applied when purge=true.
  secretsToPurge: string[];
  purge: boolean;
  // Used to resolve which secrets backend to delete from.
  backend: SecretsBackend;
}): Promise<void> {
  await fs.access(args.configPath);

  await editYamlFile(args.configPath, (doc) => {
    for (const s of args.yamlSets) setIn(doc, s.keyPath, s.value);
    if (args.purge) {
      for (const p of args.yamlPurge) deleteIn(doc, p);
    }
  });

  if (args.purge && args.secretsToPurge.length > 0) {
    for (const name of args.secretsToPurge) {
      try {
        await args.backend.delete(name);
        console.log(`✓ deleted secret ${name} from ${args.backend.id}`);
      } catch (err) {
        console.warn(`⚠ couldn't delete ${name}: ${(err as Error).message}`);
      }
    }
  }

  console.log(
    `\n✓ ${args.channelId} disabled${args.purge ? " and purged" : ""} in ${path.relative(process.cwd(), args.configPath)}.`,
  );
  console.log(
    args.purge
      ? `Run \`dae setup ${args.channelId.split(".")[0]}\` to set it up again from scratch.\n`
      : `Re-enable later with \`dae setup ${args.channelId.split(".")[0]}\` (existing secrets preserved).\n`,
  );
}

// Helper for disable flows — builds a SecretsBackend rooted at the same dir as the config.
export async function backendForDisable(ctx: SetupContext): Promise<SecretsBackend> {
  // Reuse loadConfig so the backend honors `secrets.backend`. envFileBaseDir keeps secrets
  // beside whichever config the user pointed setup/disable at.
  const config = loadConfig(ctx.configPath);
  return buildSecretsBackend(config, { envFileBaseDir: path.dirname(ctx.configPath) });
}

// Common helper: ask the user which agent should handle this channel's messages by default.
export async function askDefaultAgent(brainPath: string, fallback = "orchestrator"): Promise<string> {
  const agents = await listAgents(brainPath);
  if (agents.length === 0) {
    throw new Error(`No agents found in ${brainPath}/agents — create at least one before adding a channel.`);
  }
  const initial = agents.includes(fallback) ? agents.indexOf(fallback) : 0;
  const res = await prompts({
    type: "select",
    name: "agent",
    message: "Which agent should respond to messages from this channel by default?",
    choices: agents.map((a) => ({ title: a, value: a })),
    initial,
  });
  if (!res.agent) throw new Error("cancelled");
  return res.agent as string;
}

// Common helper: confirm + write secret to .env.local + apply YAML edits.
export async function persistChannelConfig(args: {
  configPath: string;
  envPath: string;
  envUpdates: Record<string, string>;
  yamlEdits: Array<{ keyPath: string[]; value: unknown }>;
  // For status output.
  channelId: string;
}): Promise<void> {
  // .env.local
  await upsertEnvFile(args.envPath, args.envUpdates);

  // Ensure config exists
  await fs.access(args.configPath);

  await editYamlFile(args.configPath, (doc) => {
    for (const edit of args.yamlEdits) setIn(doc, edit.keyPath, edit.value);
  });

  console.log(`\n✓ Wrote ${Object.keys(args.envUpdates).length} secret(s) to ${path.relative(process.cwd(), args.envPath)}`);
  console.log(`✓ Updated ${path.relative(process.cwd(), args.configPath)} to enable ${args.channelId}`);
  console.log(`\nRun \`dae serve\` (or \`npm run dev -- serve\`) to start the channel.\n`);
}

export async function confirm(message: string, initial = true): Promise<boolean> {
  const res = await prompts({ type: "confirm", name: "ok", message, initial });
  return Boolean(res.ok);
}

// Returns the hostname to use for local service URLs based on the configured runtime.
// When runtime.default is "docker", agents run as containers and need host.docker.internal
// to reach services on the host machine; on host runtimes plain localhost works.
export function runtimeHost(configPath: string): string {
  try {
    const config = loadConfig(configPath);
    return config.runtime.default === "docker" ? "host.docker.internal" : "localhost";
  } catch {
    return "localhost";
  }
}
