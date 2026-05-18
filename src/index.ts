#!/usr/bin/env node
// Verbose flag has to be detected BEFORE log.ts and suppress-warnings.ts load
// (they both read process.env at module-evaluation time). Cheap argv scan does
// the job — commander runs later and re-validates the same flag, so this is
// purely for early-startup env setup.
if (process.argv.slice(2).some((a) => a === "--verbose")) {
  process.env.DAE_VERBOSE = "1";
  if (!process.env.DAE_LOG_LEVEL) process.env.DAE_LOG_LEVEL = "debug";
}
// Side-effect import — MUST be after the verbose detection above so it sees
// DAE_VERBOSE; MUST be before SessionStore/ScheduleStore transitively load
// node:sqlite.
import "./cli/suppress-warnings.js";
import dotenv from "dotenv";
// Load .env first, then .env.local on top so local overrides win. .env.local is
// gitignored — the canonical place for personal secrets (API keys, tokens).
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.local", override: true });
import { installCliTerminalModes } from "./cli/terminal-modes.js";
// Disable terminal focus reporting + bracketed paste at startup so
// alt-tabbing / clicking-out mid-prompt doesn't inject escape sequences into
// the prompts library and crash on confirm/select widgets. Restored on exit.
installCliTerminalModes();
import { Command } from "commander";
import { loadConfig } from "./config/load.js";
import { applyOneCli } from "./secrets/onecli.js";
import { listAgents, loadAgent } from "./brain/agents.js";
import { listSkills } from "./brain/skills.js";
import { loadMcpConfig } from "./mcp/loader.js";
import { runAgent } from "./kernel/run.js";
import { loadSchedules, startScheduler } from "./scheduler/cron.js";
import { serve } from "./serve.js";
import { listDisables, listSetups, runDisable, runSetup, runSetupAll } from "./setup/index.js";
import { buildSecretsBackend } from "./secrets/store/factory.js";
import { SecretsOpUnsupported } from "./secrets/store/base.js";
import { initUserConfig } from "./init.js";
import { buildServiceManager } from "./service/factory.js";
import { ServiceUnsupported } from "./service/base.js";
import { SERVICE_SPECS } from "./service/specs.js";
import { runServiceInstallWizard } from "./service/wizard.js";
import { exportMempalace } from "./cli/export-mempalace.js";
import { runUpdate } from "./cli/update.js";
import prompts from "prompts";
import path from "node:path";
import { createRequire } from "node:module";
import { log } from "./log.js";

const _require = createRequire(import.meta.url);
const _pkg = _require("../package.json") as { version: string };

const program = new Command();

program
  .name("dae")
  .description("SDK-agnostic agent runner")
  .version(_pkg.version)
  .option("-c, --config <path>", "path to daedalus.config.yaml")
  .option(
    "--verbose",
    "show all logs (debug level) AND surface warnings normally filtered out (node:sqlite experimental notice, etc.)",
  );

program
  .command("run <agent>")
  .description("run an agent once with a prompt")
  .option("-p, --prompt <text>", "user prompt", "")
  .option("--stdin", "read prompt from stdin")
  .action(async (agentName: string, opts: { prompt: string; stdin?: boolean }) => {
    const config = loadConfig(program.opts().config);
    await applyOneCli(config.onecli);

    let prompt = opts.prompt;
    if (opts.stdin) {
      prompt = await readStdin();
    }
    if (!prompt) {
      console.error("Error: --prompt or --stdin required");
      process.exit(2);
    }

    const a = await loadAgent(config.brain.path, agentName);
    const result = await runAgent({
      config,
      agent: a.manifest,
      agentBody: a.body,
      prompt,
    });
    process.stdout.write(result.finalText + "\n");
    log.info({ turns: result.turns }, "run complete");
  });

// In-container single-turn entrypoint. Called by ContainerAgentDispatcher to
// run one turn of one agent inside a fresh container. The session's inbound
// message has already been persisted by the caller — we just read history,
// run the kernel, append the response, and print a JSON DispatchResult on stdout.
//
// Not really for human use; if you want to test it from a shell make sure the
// session/user already exist.
program
  .command("agent-turn")
  .description("(internal) run one turn of one agent against an existing session — used by the container dispatcher")
  .requiredOption("--agent <name>", "agent name (from brain/agents)")
  .requiredOption("--session <id>", "session id (the dispatcher caller persisted the inbound msg)")
  .requiredOption("--user <id>", "user id (for subagent session keying)")
  .option("--subagent", "system-prompt voice: 'you are operating as a subagent'", false)
  .action(
    async (opts: { agent: string; session: string; user: string; subagent: boolean }) => {
      const config = loadConfig(program.opts().config);
      await applyOneCli(config.onecli);
      const { runAgentTurn } = await import("./kernel/agent-turn.js");
      try {
        const result = await runAgentTurn({
          config,
          agentName: opts.agent,
          sessionId: opts.session,
          userId: opts.user,
          isSubagent: Boolean(opts.subagent),
        });
        // The container dispatcher scans stdout bottom-up for the JSON line.
        // Keep this the LAST thing we write.
        process.stdout.write(JSON.stringify(result) + "\n");
      } catch (err) {
        log.error({ err, agent: opts.agent }, "agent-turn failed");
        process.exit(1);
      }
    },
  );

program
  .command("agents")
  .description("list agents in the brain repo")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const names = await listAgents(config.brain.path);
    for (const n of names) console.log(n);
  });

program
  .command("skills")
  .description("list skills in the brain repo")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const names = await listSkills(config.brain.path);
    for (const n of names) console.log(n);
  });

program
  .command("mcp")
  .description("list MCP servers in the brain repo's mcp config")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const map = await loadMcpConfig(config.mcp.configPath);
    for (const [name, def] of Object.entries(map)) {
      console.log(`${name}: ${def.command ?? def.url ?? "(no command/url)"}`);
    }
  });

program
  .command("schedule")
  .description("run loaded schedules in the foreground (Ctrl-C to stop)")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    await applyOneCli(config.onecli);
    const schedules = await loadSchedules(config.brain.path);
    if (schedules.length === 0) {
      console.error("No schedules found in brain/schedules/.");
      process.exit(0);
    }
    // Open the same SessionStore + AttachmentStore the scheduler needs to dispatch
    // through the AgentDispatcher (per-schedule persistent thread, docker-mode aware).
    const { SessionStore } = await import("./sessions/store.js");
    const { AttachmentStore } = await import("./attachments/store.js");
    const sessions = new SessionStore(config.sessions.dbPath);
    const attachments = new AttachmentStore(config.sessions.attachmentsPath);
    await attachments.ensureDir();
    const { defaultSchedulerDeps } = await import("./scheduler/cron.js");
    const running = startScheduler(config, schedules, defaultSchedulerDeps(sessions, attachments));
    log.info({ count: running.length }, "scheduler running");
    const shutdown = () => {
      for (const r of running) r.job.stop();
      sessions.close();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

const setup = program
  .command("setup")
  .description("interactive setup wizard. Pass an id (telegram, whisper, …) to set up just that one.")
  .argument("[channel]", "specific integration id; omit to run the guided wizard")
  .option("--list", "list available setups instead of running the wizard")
  .action(async (channel: string | undefined, opts: { list?: boolean }) => {
    if (opts.list) {
      console.log("Available setups:");
      for (const s of listSetups()) console.log(`  ${s.id.padEnd(12)} ${s.title} — ${s.summary}`);
      return;
    }
    if (!channel) {
      // Default behavior: walk the user through every setup in turn.
      await runSetupAll(program.opts().config);
      return;
    }
    await runSetup(channel, program.opts().config);
  });

setup
  .command("list")
  .description("list available channel setups")
  .action(() => {
    for (const s of listSetups()) console.log(`${s.id}: ${s.title} — ${s.summary}`);
  });

program
  .command("disable")
  .description("turn off a previously-enabled setup (channels, search, onecli, …)")
  .argument("[thing]", "name of the thing to disable; omit to see the list")
  .option("--list", "list things that have a disable flow")
  .option("--purge", "also delete saved secrets and remove the related config block (clean slate)")
  .option("-y, --yes", "skip confirmation prompts")
  .action(async (thing: string | undefined, opts: { list?: boolean; purge?: boolean; yes?: boolean }) => {
    if (opts.list || !thing) {
      console.log("Things you can disable:");
      for (const s of listDisables()) console.log(`  ${s.id.padEnd(12)} ${s.title}`);
      return;
    }
    const disableOpts: { purge?: boolean; yes?: boolean } = {};
    if (opts.purge) disableOpts.purge = true;
    if (opts.yes) disableOpts.yes = true;
    await runDisable(thing, program.opts().config, disableOpts);
  });

program
  .command("serve")
  .description("start all configured channels and the scheduler; listens until Ctrl-C")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    await serve(config);
  });

program
  .command("identity")
  .description("show or set the orchestrator's name (the persona the user interacts with)")
  .argument("[name]", "new name; omit to print the current one")
  .option("--nickname <nickname>", "informal nickname; defaults to the name")
  .action(async (name: string | undefined, opts: { nickname?: string }) => {
    const config = loadConfig(program.opts().config);
    if (!name) {
      console.log(`name:     ${config.identity.name}`);
      console.log(`nickname: ${config.identity.nickname ?? "(same as name)"}`);
      return;
    }
    // Resolve which config file the user is targeting and edit it in place.
    const { editYamlFile, setIn } = await import("./setup/yaml-edit.js");
    const path = await import("node:path");
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const candidates = [
      program.opts().config,
      process.env.DAE_CONFIG,
      path.join(process.cwd(), "daedalus.config.yaml"),
      path.join(os.homedir(), ".daedalus", "config.yaml"),
    ].filter((p): p is string => Boolean(p));
    let target: string | null = null;
    for (const c of candidates) {
      try {
        await fs.access(c);
        target = path.resolve(c);
        break;
      } catch {
        /* not present */
      }
    }
    if (!target) {
      console.error("No daedalus.config.yaml found. Run `dae init` first.");
      process.exit(2);
    }
    await editYamlFile(target, (doc) => {
      setIn(doc, ["identity", "name"], name);
      if (opts.nickname) setIn(doc, ["identity", "nickname"], opts.nickname);
    });
    console.log(`✓ identity.name set to "${name}" in ${target}`);
    if (opts.nickname) console.log(`✓ identity.nickname set to "${opts.nickname}"`);
  });

program
  .command("install")
  .description("one-shot install: create the config (if missing), run the setup wizard, then install services")
  .action(async () => {
    // 1. Ensure config exists. If not, offer to bootstrap one at ~/.daedalus/config.yaml.
    const fsMod = await import("node:fs/promises");
    const osMod = await import("node:os");
    const candidates = [
      program.opts().config,
      process.env.DAE_CONFIG,
      path.join(process.cwd(), "daedalus.config.yaml"),
      path.join(osMod.homedir(), ".daedalus", "config.yaml"),
    ].filter((p): p is string => Boolean(p));
    let found = false;
    for (const c of candidates) {
      try {
        await fsMod.access(c);
        found = true;
        break;
      } catch {
        /* not present */
      }
    }
    if (!found) {
      console.log("No daedalus config found.");
      const { confirm } = await import("./setup/base.js");
      const ok = await confirm("Create one at ~/.daedalus/config.yaml from the example?", true);
      if (!ok) {
        console.log("Cancelled. Run `dae init` later when you're ready.");
        return;
      }
      await initUserConfig({});
    }

    // 2. Walk the setup wizard for integrations (telegram-yes / whatsapp-skip / etc).
    console.log("\n══ 1/2: integrations ══");
    await runSetupAll(program.opts().config);

    // 3. Run the service-install wizard so the runner survives logout.
    console.log("\n══ 2/2: services ══");
    try {
      const manager = await buildServiceManager();
      await runServiceInstallWizard(manager, program.opts().config);
    } catch (err) {
      // Friendly path on Windows / non-systemd Linux: just surface the message and exit
      // 0 — the user has a working config + integrations even if services aren't wired.
      if (err instanceof ServiceUnsupported) {
        console.log(`\n(skipping service install: ${err.message.split("\n")[0]})`);
        console.log("Use a process manager you already have, or come back via WSL2 / Linux / macOS.");
      } else {
        throw err;
      }
    }
    // If the supervisor service is already running, restart it so a live
    // `dae serve` picks up any new files we just wrote / replaced (avoids the
    // "attempt to write a readonly database" trap from a stale sqlite fd).
    {
      const { restartSupervisorIfActive } = await import("./service/restart-supervisor.js");
      const r = await restartSupervisorIfActive(program.opts().config);
      if (r.restarted) console.log(`\n↻ ${r.reason}`);
    }

    console.log("\nDone. Try `dae run orchestrator --prompt \"hi\"` to confirm everything's wired.");
  });

// Reverse of `dae install`. Three groups, in this order so we tear down in the
// opposite direction we built up:
//   1. Services (stop + remove unit files)
//   2. Setups   (disable each enabled integration; --purge wipes saved secrets + config blocks)
//   3. Config   (only when --purge: offer to delete the YAML + .env.local — most destructive)
//
// Does NOT remove the daedalus npm package itself (that's `npm uninstall -g
// daedalus`) and does NOT touch the brain repo (that's the user's content).
program
  .command("uninstall")
  .description("reverse `dae install`: stop services, disable integrations, optionally wipe config")
  .option("--all", "uninstall everything non-interactively (still confirms destructive --purge)")
  .option(
    "--purge",
    "also delete saved secrets, remove config blocks, and offer to delete the YAML + .env.local (clean slate)",
  )
  .option("-y, --yes", "skip confirmation prompts (use carefully with --purge — bypasses the safety check)")
  .action(async (opts: { all?: boolean; purge?: boolean; yes?: boolean }) => {
    const { confirm } = await import("./setup/base.js");
    const { WizardShell } = await import("./setup/wizard-shell.js");
    const fsMod = await import("node:fs/promises");

    // Confirm intent before doing anything irreversible. Without --yes we always
    // ask — even for non-purge runs, since uninstalling services is something a
    // user can fat-finger into.
    if (!opts.yes) {
      const warn = opts.purge
        ? "This will stop services, disable every integration, DELETE saved secrets and config blocks, and offer to delete your YAML + .env.local."
        : "This will stop services and disable every enabled integration (your config + secrets are preserved unless you re-run with --purge).";
      console.log(warn);
      const proceed = await confirm("Continue?", false);
      if (!proceed) {
        console.log("Cancelled.");
        return;
      }
    }

    // Build the step list based on what's installable + disable-able. If a
    // step has nothing to do (no installed services / not-enabled setup), it
    // still appears in the summary as a "✓ nothing to do" entry — clearer than
    // silently skipping.
    const disables = listDisables();
    const plannedSteps: Array<{ id: string; title: string }> = [
      { id: "services", title: "Services" },
      ...disables.map((s) => ({ id: s.id, title: s.title })),
    ];
    if (opts.purge) plannedSteps.push({ id: "config", title: "Config & local files" });

    const wizard = new WizardShell("Daedalus uninstall", plannedSteps);

    // 1. Services
    try {
      await wizard.step("services", "Services", async (record) => {
        let manager;
        try {
          manager = await buildServiceManager();
        } catch (err) {
          if (err instanceof ServiceUnsupported) {
            record(`platform has no service manager (${err.message.split("\n")[0]}) — nothing to do`);
            return;
          }
          throw err;
        }
        for (const specId of Object.keys(SERVICE_SPECS)) {
          try {
            const unitName = await unitNameFor(specId, program.opts().config);
            const status = await manager.status(unitName).catch(() => null);
            if (!status || !status.exists) {
              record(`${unitName}: not installed`);
              continue;
            }
            await manager.uninstall(unitName);
            record(`${unitName}: stopped + removed`);
          } catch (err) {
            record(`${specId}: failed (${(err as Error).message})`);
          }
        }
      });
    } catch {
      /* errors are recorded; keep going to the next step */
    }

    // 2. Setups (one step each — they may or may not be currently enabled,
    // but disable is idempotent so calling it always is safe).
    for (const s of disables) {
      try {
        await wizard.step(s.id, s.title, async (record) => {
          try {
            await runDisable(s.id, program.opts().config, {
              ...(opts.purge ? { purge: true } : {}),
              yes: true, // we've already taken the top-level confirmation
            });
            record(opts.purge ? "disabled + purged secrets/config" : "disabled (config + secrets preserved)");
          } catch (err) {
            const msg = (err as Error).message;
            if (/cancelled|not enabled|not found/i.test(msg)) {
              record(`nothing to do (${msg.slice(0, 80)})`);
              return;
            }
            throw err;
          }
        });
      } catch {
        /* recorded; continue */
      }
    }

    // 3. Config purge — only on --purge, and with one more confirm step (we
    // already asked once at the top; for actually deleting the YAML we ask
    // again so a stray --yes doesn't wipe a config the user wanted to keep).
    if (opts.purge) {
      try {
        await wizard.step("config", "Config & local files", async (record) => {
          // Find the config the user is currently pointing at.
          let configPath: string | undefined;
          try {
            const c = loadConfig(program.opts().config);
            // loadConfig doesn't return the path; re-derive via the same
            // discovery logic the install command uses.
            const osMod = await import("node:os");
            const candidates = [
              program.opts().config,
              process.env.DAE_CONFIG,
              path.join(process.cwd(), "daedalus.config.yaml"),
              path.join(osMod.homedir(), ".daedalus", "config.yaml"),
            ].filter((p): p is string => Boolean(p));
            for (const cand of candidates) {
              try {
                await fsMod.access(cand);
                configPath = cand;
                break;
              } catch {
                /* keep trying */
              }
            }
            void c;
          } catch {
            record("no config found — nothing to delete");
            return;
          }
          if (!configPath) {
            record("no config file located — nothing to delete");
            return;
          }
          const configDir = path.dirname(configPath);
          const envLocal = path.join(configDir, ".env.local");
          const sessionsDb = path.join(configDir, "data", "sessions.sqlite");

          // Ask one more time — this is the most destructive step.
          let okToDelete = Boolean(opts.yes);
          if (!okToDelete) {
            okToDelete = await confirm(
              `Delete ${configPath} + ${envLocal}${"" /* sessions DB stays unless asked */ }?`,
              false,
            );
          }
          if (!okToDelete) {
            record(`kept ${configPath} + .env.local (purge step declined)`);
            return;
          }
          await fsMod.rm(configPath, { force: true });
          record(`deleted ${configPath}`);
          await fsMod.rm(envLocal, { force: true }).catch(() => undefined);
          record(`deleted ${envLocal}`);
          // Sessions DB is user content too — leave it unless they really want it gone.
          record(`kept ${sessionsDb} (your session history); delete manually if you want it gone`);
        });
      } catch {
        /* recorded; continue */
      }
    }

    // If we DIDN'T uninstall the supervisor service (it was already gone, or
    // the user picked a partial path), and it happens to still be running,
    // restart it so it picks up the disabled-channels config rather than
    // bleeding errors. After a full purge this is a no-op (status check below
    // confirms the unit doesn't exist).
    {
      const { restartSupervisorIfActive } = await import("./service/restart-supervisor.js");
      const r = await restartSupervisorIfActive(program.opts().config);
      if (r.restarted) console.log(`\n↻ ${r.reason}`);
    }

    wizard.finish([
      "`npm uninstall -g daedalus` — remove the binary itself",
      ...(opts.purge
        ? []
        : ["Re-install later with `dae install`. Saved secrets + config are still here."]),
    ]);
  });

program
  .command("init")
  .description("create a per-user config at ~/.daedalus/config.yaml from the shipped example")
  .option("--force", "overwrite an existing config")
  .action(async (opts: { force?: boolean }) => {
    await initUserConfig(opts.force ? { force: true } : {});
  });

// `secret` command group — backend-agnostic CLI for the configured SecretsBackend.
const secretCmd = program
  .command("secret")
  .description("manage secrets via the configured backend (default: OneCLI if reachable, else .env.local)");

secretCmd
  .command("save <name>")
  .description("save a secret (prompts silently; OneCLI backend asks about injection too)")
  .option("-v, --value <value>", "pass the value as a flag instead of prompting (visible in argv!)")
  .option("-d, --description <text>", "optional description")
  .option(
    "-u, --url-pattern <pattern>",
    "URL host/path pattern this credential applies to (OneCLI only) — e.g. 'api.search.brave.com/*'",
  )
  .option("-a, --agent <name>", "restrict to a specific agent (OneCLI only)")
  .option("-H, --header-name <name>", "header to inject (OneCLI only) — e.g. 'Authorization'")
  .option(
    "-F, --value-format <fmt>",
    "value format with {value} placeholder (OneCLI only) — e.g. 'Bearer {value}'",
  )
  .action(
    async (
      name: string,
      opts: {
        value?: string;
        description?: string;
        urlPattern?: string;
        agent?: string;
        headerName?: string;
        valueFormat?: string;
      },
    ) => {
      const config = loadConfig(program.opts().config);
      const backend = await buildSecretsBackend(config, {
        envFileBaseDir: resolveConfigDir(program.opts().config),
      });

      let value = opts.value;
      if (!value) {
        const { secretPrompt } = await import("./setup/secret-prompt.js");
        value = (await secretPrompt({ message: `Value for ${name}:` })) ?? "";
      }
      if (!value) {
        console.error("cancelled (empty value)");
        process.exit(2);
      }

      // For OneCLI, gather injection metadata if not already provided. env-file ignores it.
      let urlPattern = opts.urlPattern;
      let agent = opts.agent;
      let headerName = opts.headerName;
      let valueFormat = opts.valueFormat;
      if (backend.id === "onecli" && !urlPattern && !headerName) {
        console.log(
          `\nOneCLI swaps placeholder keys for real ones at the network edge. Tell it which\n` +
            `requests this credential applies to and how to inject it. Leave blank to skip.\n`,
        );
        const r = await prompts([
          {
            type: "text",
            name: "urlPattern",
            message: "URL host/path pattern (e.g. api.search.brave.com/*):",
          },
          { type: "text", name: "agent", message: "Restrict to agent (blank = any):" },
          {
            type: "text",
            name: "headerName",
            message: "Inject as which header?",
            initial: "Authorization",
          },
          {
            type: "text",
            name: "valueFormat",
            message: "Value format ({value} = the secret):",
            initial: "Bearer {value}",
          },
        ]);
        urlPattern = (r.urlPattern as string) || undefined;
        agent = (r.agent as string) || undefined;
        headerName = (r.headerName as string) || undefined;
        valueFormat = (r.valueFormat as string) || undefined;
      }

      const saveOpts: Parameters<typeof backend.save>[2] = {};
      if (opts.description) saveOpts.description = opts.description;
      if (urlPattern) saveOpts.urlPattern = urlPattern;
      if (agent) saveOpts.agent = agent;
      if (headerName) {
        saveOpts.injectionConfig = { headerName };
        if (valueFormat) saveOpts.injectionConfig.valueFormat = valueFormat;
      }

      try {
        await backend.save(name, value, saveOpts);
        const detail = urlPattern || headerName ? ` (urlPattern=${urlPattern ?? "*"}, header=${headerName ?? "—"})` : "";
        console.log(`saved ${name} via ${backend.id}${detail}`);
      } catch (err) {
        if (err instanceof SecretsOpUnsupported) {
          console.error(`✗ ${err.message}`);
          process.exit(2);
        }
        throw err;
      }
    },
  );

secretCmd
  .command("get <name>")
  .description("print a secret to stdout (use carefully — visible in shell history)")
  .action(async (name: string) => {
    const config = loadConfig(program.opts().config);
    const backend = await buildSecretsBackend(config, { envFileBaseDir: resolveConfigDir(program.opts().config) });
    const value = await backend.get(name);
    if (value === null) {
      console.error(`not found: ${name}`);
      process.exit(1);
    }
    process.stdout.write(value);
  });

secretCmd
  .command("list")
  .description("list secret names (values are never printed)")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const backend = await buildSecretsBackend(config, { envFileBaseDir: resolveConfigDir(program.opts().config) });
    const entries = await backend.list();
    console.log(`backend: ${backend.id}`);
    if (!entries.length) {
      console.log("(no secrets)");
      return;
    }
    for (const e of entries) console.log(e.description ? `${e.name}  — ${e.description}` : e.name);
  });

secretCmd
  .command("delete <name>")
  .description("remove a secret")
  .action(async (name: string) => {
    const config = loadConfig(program.opts().config);
    const backend = await buildSecretsBackend(config, { envFileBaseDir: resolveConfigDir(program.opts().config) });
    await backend.delete(name);
    console.log(`deleted ${name}`);
  });

secretCmd
  .command("backend")
  .description("show which backend would be used and whether it's reachable")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const backend = await buildSecretsBackend(config, { envFileBaseDir: resolveConfigDir(program.opts().config) });
    console.log(`backend: ${backend.id}`);
    console.log(
      `capabilities: ${Object.entries(backend.capabilities)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .join(", ")}`,
    );
  });

function resolveConfigDir(configPath: string | undefined): string {
  if (!configPath) return process.cwd();
  return path.dirname(path.resolve(configPath));
}

// `service` command group — install/manage daedalus (and helpers) as a long-running service.
const serviceCmd = program
  .command("service")
  .description("manage daedalus as a long-running service (systemd on Linux/WSL, launchd on macOS)");

serviceCmd
  .command("install [name]")
  .description("install service units. With no args: interactive wizard. With <name>: just that one. With --all: every spec, non-interactively.")
  .option("--dry-run", "print the unit content without writing or starting anything")
  .option("--all", "install every spec without prompting")
  .option("--list", "list available service specs instead of installing")
  .action(async (name: string | undefined, opts: { dryRun?: boolean; all?: boolean; list?: boolean }) => {
    if (opts.list) {
      for (const id of Object.keys(SERVICE_SPECS)) console.log(id);
      return;
    }
    try {
      const manager = await buildServiceManager();

      // Wizard mode: no name, no --all → interactive multi-select.
      if (!name && !opts.all) {
        await runServiceInstallWizard(manager, program.opts().config, opts.dryRun ? { dryRun: true } : {});
        return;
      }

      console.log(`Platform: ${manager.platformLabel}`);
      const targets = opts.all ? Object.keys(SERVICE_SPECS) : [name!];
      for (const t of targets) {
        const builder = SERVICE_SPECS[t];
        if (!builder) {
          console.error(`Unknown service '${t}'. Known: ${Object.keys(SERVICE_SPECS).join(", ")}`);
          process.exit(2);
        }
        console.log(`\n── ${t} ──`);
        const spec = await builder(program.opts().config);
        const result = await manager.install(spec, opts.dryRun ? { dryRun: true } : {});
        if (opts.dryRun) {
          console.log(`\n--- ${result.unitPath} ---`);
          console.log(result.unitContent);
        }
        for (const note of result.notes) console.log(note);
      }
      // If the supervisor is already running, restart it after any service
      // install — the user asked for the runner to pick up new state /
      // sibling units immediately. Skipped in dry-run.
      if (!opts.dryRun) {
        const { restartSupervisorIfActive } = await import("./service/restart-supervisor.js");
        const r = await restartSupervisorIfActive(program.opts().config);
        if (r.restarted) console.log(`\n↻ ${r.reason}`);
      }
    } catch (err) {
      handleServiceError(err);
    }
  });

serviceCmd
  .command("uninstall [name]")
  .description("stop, disable, and remove service units. <name> for one; --all for every installed spec.")
  .option("--all", "uninstall every spec without prompting")
  .action(async (name: string | undefined, opts: { all?: boolean }) => {
    try {
      const manager = await buildServiceManager();
      let targets: string[];
      if (opts.all) {
        targets = Object.keys(SERVICE_SPECS);
      } else if (name) {
        targets = [name];
      } else {
        // Default to daedalus (the runner). It's the most-asked uninstall and "interactive
        // multi-uninstall" is rare enough that we don't surface a wizard here.
        targets = ["daedalus"];
      }
      for (const t of targets) {
        const unitName = await unitNameFor(t, program.opts().config);
        await manager.uninstall(unitName);
        console.log(`✓ ${unitName} uninstalled`);
      }
    } catch (err) {
      handleServiceError(err);
    }
  });

for (const op of ["start", "stop", "restart"] as const) {
  serviceCmd
    .command(`${op} [name]`)
    .description(`${op} a service (default: 'daedalus')`)
    .action(async (name: string | undefined) => {
      const target = name ?? "daedalus";
      try {
        const manager = await buildServiceManager();
        const unitName = await unitNameFor(target, program.opts().config);
        await manager[op](unitName);
        console.log(`✓ ${unitName} ${op}ed`);
      } catch (err) {
        handleServiceError(err);
      }
    });
}

serviceCmd
  .command("status [name]")
  .description("show service status (default: 'daedalus')")
  .action(async (name: string | undefined) => {
    const target = name ?? "daedalus";
    try {
      const manager = await buildServiceManager();
      const unitName = await unitNameFor(target, program.opts().config);
      const s = await manager.status(unitName);
      console.log(`${unitName}: ${s.active ? "active" : s.exists ? "inactive" : "(not installed)"}`);
      if (s.detail) console.log(s.detail);
    } catch (err) {
      handleServiceError(err);
    }
  });

serviceCmd
  .command("logs [name]")
  .description("print the command for tailing logs (default: 'daedalus')")
  .action(async (name: string | undefined) => {
    const target = name ?? "daedalus";
    try {
      const manager = await buildServiceManager();
      const unitName = await unitNameFor(target, program.opts().config);
      console.log(manager.logsCommand(unitName));
    } catch (err) {
      handleServiceError(err);
    }
  });

serviceCmd
  .command("list")
  .description("list service specs available to install")
  .action(() => {
    for (const id of Object.keys(SERVICE_SPECS)) console.log(id);
  });

async function unitNameFor(target: string, configPath: string | undefined): Promise<string> {
  const builder = SERVICE_SPECS[target];
  if (!builder) return target; // allow operating on arbitrary unit names too
  const spec = await builder(configPath);
  return spec.name;
}

function handleServiceError(err: unknown): never {
  if (err instanceof ServiceUnsupported) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}

program
  .command("export <what>")
  .description("export config snippets for other devices/clients (currently: 'mempalace')")
  .option("--host <hostname>", "override the suggested LAN hostname/IP")
  .action(async (what: string, opts: { host?: string }) => {
    if (what === "mempalace") {
      await exportMempalace({
        ...(program.opts().config ? { configPath: program.opts().config } : {}),
        ...(opts.host ? { hostOverride: opts.host } : {}),
      });
      return;
    }
    console.error(`Unknown export target: ${what}. Known: mempalace`);
    process.exit(2);
  });

program
  .command("update")
  .description("check for a newer release and install it")
  .option("--check", "check for updates without installing")
  .action(async (opts: { check?: boolean }) => {
    await runUpdate(opts);
  });

program
  .command("config")
  .description("print resolved config as JSON")
  .action(() => {
    const config = loadConfig(program.opts().config);
    console.log(JSON.stringify(config, null, 2));
  });

async function readStdin(): Promise<string> {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) data += chunk;
  return data.trim();
}

program.parseAsync().catch((err) => {
  log.error({ err }, "command failed");
  process.exit(1);
});
