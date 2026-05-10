import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { telegramSetup } from "./telegram.js";
import { whatsappSetup } from "./whatsapp.js";
import { searchSetup } from "./search.js";
import { onecliSetup } from "./onecli.js";
import { mempalaceSetup } from "./mempalace.js";
import { whisperSetup } from "./whisper.js";
import type { ChannelSetup, SetupContext } from "./base.js";
import { loadConfig } from "../config/load.js";

const REGISTRY: Record<string, ChannelSetup> = {
  telegram: telegramSetup,
  whatsapp: whatsappSetup,
  search: searchSetup,
  onecli: onecliSetup,
  mempalace: mempalaceSetup,
  whisper: whisperSetup,
};

export function listSetups(): ChannelSetup[] {
  return Object.values(REGISTRY);
}

// Suggested setup order for `setup all`: foundational pieces first (so secrets and proxy
// behaviour are correct before later flows store credentials), then capabilities, then
// channels.
const ALL_ORDER = ["onecli", "search", "whisper", "mempalace", "telegram", "whatsapp"] as const;

export async function runSetupAll(configPathArg: string | undefined): Promise<void> {
  // Lazy import so we don't pull prompts before we know we need it.
  const { default: prompts } = await import("prompts");

  const config = loadConfig(configPathArg);
  const configPath = await resolveConfigPath(configPathArg);
  if (!configPath) {
    throw new Error(
      "No daedalus.config.yaml found. Run `dae init` first to create a per-user config.",
    );
  }
  const envPath = path.join(path.dirname(configPath), ".env.local");
  const ctx: SetupContext = { configPath, envPath, brainPath: config.brain.path };

  console.log(`\nGuided setup. I'll ask about each integration in turn.\n`);
  console.log(`Config: ${configPath}\n`);

  for (const id of ALL_ORDER) {
    const setup = REGISTRY[id];
    if (!setup) continue;
    console.log(`\n── ${setup.id}: ${setup.title} ──`);
    console.log(`   ${setup.summary}\n`);
    const r = await prompts({
      type: "select",
      name: "action",
      message: "Set this up now?",
      choices: [
        { title: "yes — walk me through it", value: "yes" },
        { title: "skip this one", value: "skip" },
        { title: "stop the wizard here", value: "stop" },
      ],
      initial: 0,
    });
    const action = r.action as "yes" | "skip" | "stop" | undefined;
    if (!action || action === "stop") {
      console.log("\nWizard stopped. Re-run later with `dae setup` to continue.");
      return;
    }
    if (action === "skip") continue;
    try {
      await setup.run(ctx);
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "cancelled") {
        console.log(`(skipped ${id})`);
      } else {
        console.error(`✗ ${id} failed: ${msg}`);
        const cont = await prompts({
          type: "confirm",
          name: "ok",
          message: "Continue with the rest of the wizard?",
          initial: true,
        });
        if (!cont.ok) return;
      }
    }
  }
  console.log("\nAll done. Run `dae service install --all` to run the runner + helpers as services.\n");
}

export function listDisables(): ChannelSetup[] {
  return Object.values(REGISTRY).filter((s) => typeof s.disable === "function");
}

export async function runDisable(
  channelId: string,
  configPathArg: string | undefined,
  opts: { purge?: boolean; yes?: boolean } = {},
): Promise<void> {
  const setup = REGISTRY[channelId];
  if (!setup) {
    throw new Error(`Unknown channel: ${channelId}. Known: ${Object.keys(REGISTRY).join(", ")}`);
  }
  if (!setup.disable) {
    throw new Error(
      `'${channelId}' has no disable flow. Edit your daedalus.config.yaml directly to turn it off.`,
    );
  }
  const config = loadConfig(configPathArg);
  const configPath = await resolveConfigPath(configPathArg);
  if (!configPath) {
    throw new Error("No daedalus.config.yaml found — nothing to disable.");
  }
  const envPath = path.join(path.dirname(configPath), ".env.local");
  await setup.disable(
    { configPath, envPath, brainPath: config.brain.path },
    { purge: Boolean(opts.purge), yes: Boolean(opts.yes) },
  );
}

export async function runSetup(channelId: string, configPathArg: string | undefined): Promise<void> {
  const setup = REGISTRY[channelId];
  if (!setup) {
    throw new Error(
      `Unknown channel: ${channelId}. Known: ${Object.keys(REGISTRY).join(", ")}`,
    );
  }

  const config = loadConfig(configPathArg);
  // Resolve the actual path of the config file used so we can write back to it.
  const configPath = await resolveConfigPath(configPathArg);
  if (!configPath) {
    throw new Error(
      "No daedalus.config.yaml found. Create one (see examples/daedalus.config.yaml) before running setup.",
    );
  }

  const envPath = path.join(path.dirname(configPath), ".env.local");
  const ctx: SetupContext = { configPath, envPath, brainPath: config.brain.path };
  await setup.run(ctx);
}

async function resolveConfigPath(arg: string | undefined): Promise<string | null> {
  const userDir = path.join(os.homedir(), ".daedalus");
  const candidates = arg
    ? [arg]
    : [
        process.env.DAE_CONFIG,
        path.join(process.cwd(), "daedalus.config.yaml"),
        path.join(process.cwd(), "daedalus.config.yml"),
        path.join(process.cwd(), "daedalus.config.json"),
        path.join(userDir, "config.yaml"),
        path.join(userDir, "daedalus.config.yaml"),
        path.join(userDir, "config.yml"),
      ].filter((p): p is string => Boolean(p));
  for (const p of candidates) {
    try {
      await fs.access(p);
      return path.resolve(p);
    } catch {
      /* not present */
    }
  }
  return null;
}
