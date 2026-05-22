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
  const { default: prompts } = await import("prompts");
  const { WizardShell } = await import("./wizard-shell.js");

  const config = loadConfig(configPathArg);
  const configPath = await resolveConfigPath(configPathArg);
  if (!configPath) {
    throw new Error(
      "No daedalus.config.yaml found. Run `dae init` first to create a per-user config.",
    );
  }
  const envPath = path.join(path.dirname(configPath), ".env.local");
  const ctx: SetupContext = { configPath, envPath, brainPath: config.brain.path };

  const planned = ALL_ORDER
    .map((id) => REGISTRY[id])
    .filter((s): s is NonNullable<typeof s> => Boolean(s))
    .map((s) => ({ id: s.id, title: s.title }));
  const wizard = new WizardShell("Daedalus setup", planned);

  for (const id of ALL_ORDER) {
    const setup = REGISTRY[id];
    if (!setup) continue;
    // Ask per-step BEFORE clearing — the question is part of the step header
    // visually. The step body (the actual setup run) is what fills the screen
    // after the user picks "yes".
    const ask = await prompts({
      type: "select",
      name: "action",
      message: `${setup.title} — ${setup.summary}`,
      choices: [
        { title: "yes — walk me through it", value: "yes" },
        { title: "skip this one", value: "skip" },
        { title: "stop the wizard here", value: "stop" },
      ],
      initial: 0,
    });
    const action = ask.action as "yes" | "skip" | "stop" | undefined;
    if (!action || action === "stop") {
      // Render whatever we've done so far + the user's stop.
      wizard.finish([
        "Wizard stopped. Re-run later with `dae setup` to continue.",
      ]);
      return;
    }
    if (action === "skip") {
      wizard.skip(setup.id, setup.title, "user skipped");
      continue;
    }
    try {
      await wizard.step(setup.id, setup.title, async (record) => {
        await setup.run(ctx, { record });
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "cancelled") {
        // step() already recorded status=skipped on "cancelled". Just continue.
        continue;
      }
      // Failed step: ask whether to bail out of the whole wizard.
      const cont = await prompts({
        type: "confirm",
        name: "ok",
        message: `'${setup.id}' failed: ${msg}\n  Continue with the rest of the wizard?`,
        initial: true,
      });
      if (!cont.ok) {
        wizard.finish([
          "Wizard stopped after a failure. Fix the issue and re-run `dae setup`.",
        ]);
        return;
      }
    }
  }
  wizard.finish([
    "`dae install`        — bring the docker stack up (supervisor + scheduler + memory)",
    "`docker compose up -d` — same, if you've already written the compose .env",
  ]);
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
