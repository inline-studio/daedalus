#!/usr/bin/env -S node --disable-warning=ExperimentalWarning
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
import { listAgents } from "./brain/agents.js";
import { listSkills } from "./brain/skills.js";
import { loadMcpConfig } from "./mcp/loader.js";
import { loadSchedules, startScheduler } from "./scheduler/cron.js";
import { serve } from "./serve.js";
import { listDisables, listSetups, runDisable, runSetup, runSetupAll } from "./setup/index.js";
import { buildSecretsBackend } from "./secrets/store/factory.js";
import { SecretsOpUnsupported } from "./secrets/store/base.js";
import { initUserConfig } from "./init.js";
import { runInstall, findComposeFile } from "./install.js";
import { DISPATCH_RESULT_SENTINEL, DISPATCH_EVENT_SENTINEL } from "./dispatch/base.js";
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
  .option("--origin-channel <channel>", "channel the originating user spoke on (for schedule_message routing)")
  .option("--origin-external-user <id>", "external id of the originating user (for schedule_message routing)")
  .option(
    "--remote-exec-user <userId>",
    "run this turn's tools on the user's machine via the remote-exec bridge (needs DAE_RPC_URL + DAE_RPC_TOKEN in env)",
  )
  .action(
    async (opts: {
      agent: string;
      session: string;
      user: string;
      subagent: boolean;
      originChannel?: string;
      originExternalUser?: string;
      remoteExecUser?: string;
    }) => {
      const config = loadConfig(program.opts().config);
      await applyOneCli(config.onecli);
      const { runAgentTurn } = await import("./kernel/agent-turn.js");
      // Remote execution: the dispatcher put the bridge URL + user on the argv/env; the
      // token rides in env only (SEC-09). All three present → the turn's tools run on
      // the user's machine.
      let remoteExecEnv: Record<string, string> | undefined;
      try {
        if (process.env.DAE_RPC_ENV) {
          remoteExecEnv = JSON.parse(process.env.DAE_RPC_ENV) as Record<string, string>;
        }
      } catch {
        /* a garbled env description just means a generic context line */
      }
      const remoteExec =
        opts.remoteExecUser && process.env.DAE_RPC_URL && process.env.DAE_RPC_TOKEN
          ? {
              userId: opts.remoteExecUser,
              url: process.env.DAE_RPC_URL,
              token: process.env.DAE_RPC_TOKEN,
              ...(remoteExecEnv ? { env: remoteExecEnv } : {}),
            }
          : undefined;
      // Live event streaming across the container hop: when the spawning dispatcher set
      // DAE_EVENT_STREAM=ndjson, write each TurnEvent as a sentinel-framed JSON line as the
      // turn unfolds. The leading newline guarantees the sentinel begins a fresh line even
      // when interleaved with other stdout noise (same trick as the result line below).
      const streamEvents = process.env.DAE_EVENT_STREAM === "ndjson";
      try {
        const result = await runAgentTurn({
          config,
          agentName: opts.agent,
          sessionId: opts.session,
          userId: opts.user,
          isSubagent: Boolean(opts.subagent),
          ...(opts.originChannel ? { originChannel: opts.originChannel } : {}),
          ...(opts.originExternalUser
            ? { originExternalUserId: opts.originExternalUser }
            : {}),
          ...(remoteExec ? { remoteExec } : {}),
          ...(streamEvents
            ? {
                onEvent: (ev: import("./types.js").TurnEvent) => {
                  try {
                    process.stdout.write(
                      "\n" + DISPATCH_EVENT_SENTINEL + JSON.stringify(ev) + "\n",
                    );
                  } catch {
                    /* an unserialisable event must never break the turn */
                  }
                },
              }
            : {}),
        });
        // The container dispatcher parses the sentinel-framed result line (BUG-01). The leading
        // newline guarantees the sentinel begins a fresh line even if prior output didn't end in
        // one. Keep this the LAST thing we write.
        process.stdout.write("\n" + DISPATCH_RESULT_SENTINEL + JSON.stringify(result) + "\n");
      } catch (err) {
        log.error({ err, agent: opts.agent }, "agent-turn failed");
        process.exit(1);
      }
    },
  );

program
  .command("agent-worker")
  .description(
    "(internal) long-lived warm agent worker — serves top-level turns over HTTP for the persistent dispatcher",
  )
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const { runAgentWorker } = await import("./kernel/agent-worker.js");
    await runAgentWorker(config);
  });

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

// `skill` command group — review queue for agent-created skills. When
// skills.learning.writeApproval is on, every create/patch the review pass makes lands in
// <brain>/skills/.pending/ instead of going live; these commands are how the operator
// promotes or discards them.
const skillCmd = program
  .command("skill")
  .description("review agent-created skills awaiting approval (skills/.pending)");

skillCmd
  .command("pending")
  .description("list staged skills awaiting approval")
  .action(async () => {
    const config = loadConfig(program.opts().config);
    const { listPendingSkills } = await import("./tools/skill-manage.js");
    const pending = await listPendingSkills(config.brain.path);
    if (!pending.length) {
      console.log("(no pending skills)");
      return;
    }
    for (const p of pending) {
      console.log(`${p.name}  ${p.patchesExisting ? "[patch]" : "[new]"}  ${p.description}`);
    }
    console.log(`\nApprove with \`dae skill approve <name>\`, discard with \`dae skill reject <name>\`.`);
  });

skillCmd
  .command("approve <name>")
  .description("promote a staged skill to the live brain")
  .action(async (name: string) => {
    const config = loadConfig(program.opts().config);
    const { approvePendingSkill } = await import("./tools/skill-manage.js");
    await approvePendingSkill(config.brain.path, name);
    console.log(`✓ skill '${name}' is live`);
  });

skillCmd
  .command("reject <name>")
  .description("discard a staged skill")
  .action(async (name: string) => {
    const config = loadConfig(program.opts().config);
    const { rejectPendingSkill } = await import("./tools/skill-manage.js");
    await rejectPendingSkill(config.brain.path, name);
    console.log(`✗ skill '${name}' discarded`);
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
  .command("remote")
  .alias("chat")
  .description(
    "the daedalus terminal interface: chat with the server-side agent while its bash/read/write run HERE. " +
      "First run with no arguments launches a setup wizard (profile: ~/.daedalus/remote.json).",
  )
  .argument("[url]", "the server's web channel URL (defaults to the saved profile)")
  .option("--token <token>", "bearer token (token-auth servers)")
  .option("--user <username>", "login username (login-auth servers; prompts for the password)")
  .option("--workspace <dir>", "directory commands and file ops are rooted in")
  .option("--yolo", "skip per-command confirmation (dangerous commands still prompt)")
  .option("--id <externalUserId>", "override the client identity (default: remote-<hostname>)")
  .option("--plain", "line-mode output instead of the full terminal interface", false)
  .action(async (url, opts) => runRemoteFlow(url, opts));

// The terminal-interface flow behind both `dae` (no arguments) and `dae remote`.
async function runRemoteFlow(
  url: string | undefined,
  opts: {
    token?: string;
    user?: string;
    workspace?: string;
    yolo?: boolean;
    id?: string;
    plain: boolean;
  },
): Promise<void> {
  {
      const shared = await import("./cli/remote-shared.js");
      const saved = shared.loadProfile() ?? {};

      // Resolution order: explicit flags → saved profile → first-run wizard.
      let profile = {
        url: url ?? saved.url ?? "",
        token: opts.token ?? saved.token,
        username: opts.user ?? saved.username,
        workspace: opts.workspace ?? saved.workspace ?? process.cwd(),
        execution: saved.execution ?? ("local" as const),
        approval: opts.yolo ? ("yolo" as const) : (saved.approval ?? ("ask" as const)),
        externalUserId: opts.id ?? saved.externalUserId,
      };

      if (!profile.url) {
        if (!process.stdin.isTTY) {
          console.error("No server URL: pass one (`dae remote <url>`) or run the wizard in a terminal first.");
          process.exit(2);
        }
        console.log("First run — let's connect this machine to your daedalus.\n");
        // Local shortcut: if this machine hosts a daedalus stack, offer it — prefill the
        // loopback URL (and the web login username when the config carries one).
        let localUrl = "";
        let localUsername = "";
        try {
          const cfg = loadConfig(program.opts<{ config?: string }>().config);
          const web = cfg.channels?.web;
          if (web?.enabled) {
            localUrl = `http://127.0.0.1:${web.port ?? 8765}`;
            if (web.username) localUsername = web.username;
          }
        } catch {
          /* no local install — remote-only wizard */
        }
        const where = localUrl
          ? await prompts({
              type: "select",
              name: "where",
              message: "Where does your daedalus run?",
              choices: [
                { title: `On this machine (${localUrl})`, value: "local" },
                { title: "On a remote server", value: "remote" },
              ],
            })
          : { where: "remote" };
        if (where.where === undefined) {
          console.log("Cancelled.");
          process.exit(2);
        }
        const isLocal = where.where === "local";
        const answers = await prompts([
          {
            type: "text",
            name: "url",
            message: "Server URL (the address the web UI uses):",
            initial: isLocal ? localUrl : "",
            validate: (v: string) => (/^https?:\/\//.test(v.trim()) ? true : "http(s):// URL required"),
          },
          {
            type: "select",
            name: "auth",
            message: "How does the server authenticate?",
            choices: [
              { title: "Username + password (login mode)", value: "login" },
              { title: "Bearer token", value: "token" },
              { title: "None / handled by my proxy", value: "open" },
            ],
            initial: isLocal && localUsername ? 0 : undefined,
          },
          {
            type: (prev: string) => (prev === "login" ? "text" : null),
            name: "username",
            message: "Username:",
            initial: localUsername || undefined,
          },
          { type: (_p: string, v: { auth?: string }) => (v.auth === "token" ? "password" : null), name: "token", message: "Token:" },
          {
            type: "text",
            name: "workspace",
            message: "Workspace (commands + file ops run here):",
            initial: path.join(process.env.HOME ?? process.cwd(), "dae-workspace"),
          },
          {
            type: "select",
            name: "approval",
            message: "Command approval:",
            choices: [
              { title: "Ask for each command (recommended)", value: "ask" },
              { title: "Free rein (dangerous commands still ask)", value: "yolo" },
            ],
          },
        ]);
        if (!answers.url) {
          console.log("Cancelled.");
          process.exit(2);
        }
        profile = {
          url: String(answers.url).trim().replace(/\/$/, ""),
          token: answers.token ? String(answers.token) : undefined,
          username: answers.username ? String(answers.username) : undefined,
          workspace: String(answers.workspace),
          execution: "local",
          approval: answers.approval === "yolo" ? "yolo" : "ask",
          externalUserId: undefined,
        };
        shared.saveProfile({
          url: profile.url,
          ...(profile.token ? { token: profile.token } : {}),
          ...(profile.username ? { username: profile.username } : {}),
          workspace: profile.workspace,
          execution: profile.execution,
          approval: profile.approval,
        });
        console.log(`Saved to ${shared.profilePath()} — next time just run \`dae remote\`.\n`);
      }

      let password: string | undefined;
      if (profile.username) {
        const { secretPrompt } = await import("./setup/secret-prompt.js");
        password = (await secretPrompt({ message: `Password for ${profile.username}:` })) ?? "";
      }

      if (opts.plain || !process.stdin.isTTY || !process.stdout.isTTY) {
        const { runRemoteClient } = await import("./cli/remote-client.js");
        await runRemoteClient({
          url: profile.url,
          workspace: profile.workspace,
          yolo: profile.approval === "yolo",
          ...(profile.token ? { token: profile.token } : {}),
          ...(profile.username ? { username: profile.username } : {}),
          ...(password !== undefined ? { password } : {}),
          ...(profile.externalUserId ? { externalUserId: profile.externalUserId } : {}),
        });
      } else {
        const { runRemoteTui } = await import("./cli/remote-tui.js");
        await runRemoteTui({
          url: profile.url,
          ...(profile.token ? { token: profile.token } : {}),
          ...(profile.username ? { username: profile.username } : {}),
          ...(password !== undefined ? { password } : {}),
          workspace: profile.workspace,
          execution: profile.execution,
          approval: profile.approval,
          ...(profile.externalUserId ? { externalUserId: profile.externalUserId } : {}),
        });
      }
  }
}

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
  .description("turnkey install: create the config (if missing), then bring the docker stack up with `docker compose`")
  .option("--fresh", "reconfigure from scratch (ask every question) instead of reusing your existing setup")
  .action(async (opts: { fresh?: boolean }) => {
    await runInstall({ config: program.opts().config, fresh: Boolean(opts.fresh) });
  });

// Reverse of `dae install`: stop the docker stack. With --purge it also deletes the
// config + .env files. Data (docker volumes + host bind-mounts) is ALWAYS preserved —
// uninstall never passes `-v`. Does NOT remove the daedalus npm package (that's
// `npm uninstall -g daedalus`) and does NOT touch the brain repo (the user's content).
program
  .command("uninstall")
  .description("stop the docker stack (with --purge: also delete the config + .env files)")
  .option(
    "--purge",
    "also delete the config + .env files (clean slate). Data volumes are always preserved.",
  )
  .option("-y, --yes", "skip confirmation prompts")
  .action(async (opts: { purge?: boolean; yes?: boolean }) => {
    const { confirm } = await import("./setup/base.js");
    const fsMod = await import("node:fs/promises");
    const osMod = await import("node:os");
    const { execa } = await import("execa");

    if (!opts.yes) {
      const warn = opts.purge
        ? "This stops the daedalus stack and deletes your config + .env files. Your data (docker\nvolumes: sessions, shared workspace, memory; and bind-mounts) is preserved."
        : "This stops the daedalus stack (containers). Config and all data are preserved.";
      console.log(warn);
      if (!(await confirm("Continue?", false))) {
        console.log("Cancelled.");
        return;
      }
    }

    // 1. Tear down containers via docker compose. `--profile whisper` so the
    // profile-gated whisper container is removed too (a bare `down` only acts on
    // active profiles and would leave it running). We never pass -v: volumes (and
    // the host bind-mounts) hold the user's data and must survive an uninstall — to
    // wipe data deliberately, the user can run `docker compose down -v` themselves.
    const composeFile = await findComposeFile();
    if (composeFile) {
      const composeDir = path.dirname(composeFile);
      const args = ["compose", "-f", composeFile, "--profile", "whisper", "down"];
      console.log(`\n$ docker ${args.join(" ")}\n`);
      await execa("docker", args, { stdio: "inherit", cwd: composeDir }).catch((err) => {
        console.error(`compose down failed: ${(err as Error).message}`);
      });
    } else {
      console.log("(no docker-compose.yml found — skipping container teardown)");
    }

    // 2. Config + local files — only on --purge.
    if (opts.purge) {
      const candidates = [
        program.opts().config,
        process.env.DAE_CONFIG,
        path.join(process.cwd(), "daedalus.config.yaml"),
        path.join(osMod.homedir(), ".daedalus", "config.yaml"),
      ].filter((p): p is string => Boolean(p));
      let configPath: string | undefined;
      for (const cand of candidates) {
        try {
          await fsMod.access(cand);
          configPath = cand;
          break;
        } catch {
          /* keep trying */
        }
      }
      if (configPath) {
        const configDir = path.dirname(configPath);
        const envLocal = path.join(configDir, ".env.local");
        const composeEnv = composeFile ? path.join(path.dirname(composeFile), ".env") : undefined;
        let okToDelete = Boolean(opts.yes);
        if (!okToDelete) {
          okToDelete = await confirm(`Delete ${configPath} + ${envLocal}?`, false);
        }
        if (okToDelete) {
          await fsMod.rm(configPath, { force: true });
          console.log(`deleted ${configPath}`);
          await fsMod.rm(envLocal, { force: true }).catch(() => undefined);
          console.log(`deleted ${envLocal}`);
          if (composeEnv) await fsMod.rm(composeEnv, { force: true }).catch(() => undefined);
        } else {
          console.log(`kept ${configPath} + .env.local (purge declined)`);
        }
      } else {
        console.log("(no config file located — nothing to delete)");
      }
    }

    console.log("\nDone. `npm uninstall -g daedalus` removes the CLI itself.");
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

// `web` command group — helpers for the built-in web login.
const webCmd = program.command("web").description("web UI helpers (login password hashing)");

webCmd
  .command("hash-password")
  .description("scrypt-hash a web-login password for WEB_PASSWORD_HASH (prompts silently)")
  .option("-v, --value <password>", "pass the password as a flag instead of prompting (visible in argv!)")
  .action(async (opts: { value?: string }) => {
    const { hashPassword } = await import("./channels/web-auth.js");
    let pw = opts.value;
    if (!pw) {
      const { secretPrompt } = await import("./setup/secret-prompt.js");
      pw = (await secretPrompt({ message: "Web login password:" })) ?? "";
    }
    if (!pw) {
      console.error("cancelled (empty password)");
      process.exit(2);
    }
    const hash = hashPassword(pw);
    console.log(hash); // stdout: just the hash, so it's pipeable
    console.error("\nAdd to your runner .env.local (e.g. ~/.daedalus/.env.local):");
    console.error("  WEB_PASSWORD_HASH=" + hash);
    console.error("…plus WEB_USERNAME and a random WEB_SESSION_SECRET. `dae install` sets all three for you.");
  });

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
    await runUpdate({ ...opts, ...(program.opts().config ? { config: program.opts().config as string } : {}) });
  });

program
  .command("config")
  .description("print resolved config as JSON")
  .action(() => {
    const config = loadConfig(program.opts().config);
    console.log(JSON.stringify(config, null, 2));
  });

// Bare `dae` in a terminal IS the interface (Hermes/Claude-CLI shape): launch the
// terminal client — the first run walks through local/remote setup. Anything else
// (flags, subcommands, pipes) goes through commander as usual.
if (process.argv.length <= 2 && process.stdin.isTTY && process.stdout.isTTY) {
  runRemoteFlow(undefined, { plain: false }).catch((err) => {
    log.error({ err }, "command failed");
    process.exit(1);
  });
} else {
  program.parseAsync().catch((err) => {
    log.error({ err }, "command failed");
    process.exit(1);
  });
}
