import prompts from "prompts";
import path from "node:path";
import os from "node:os";
import {
  backendForDisable,
  confirm,
  persistChannelDisable,
  type ChannelSetup,
  type DisableOptions,
  type SetupContext,
  type SetupRunOptions,
} from "./base.js";
import { removeMcpServer, hasMcpServer } from "./mcp-edit.js";
import { secretPrompt } from "./secret-prompt.js";
import { editYamlFile, setIn, deleteIn } from "./yaml-edit.js";
import { loadConfig } from "../config/load.js";
import { upsertEnvFile } from "./env-file.js";
import fs from "node:fs/promises";

export const mempalaceSetup: ChannelSetup = {
  id: "mempalace",
  title: "MemPalace memory backend",
  summary:
    "Wire MemPalace as the persistent memory store. MemPalace runs as the `mempalace` container; this records the palace path + optional token and points every agent at it.",

  // daedalus is docker-only: MemPalace's MCP server is stdio-only, so it runs as the
  // `mempalace` compose service (mcp-proxy fronting it) and every agent reaches it over
  // the daedalus network. There's no host-daemon / "where does it live" choice — this
  // just records the palace path + optional token and points the built-in auto-inject
  // at the container.
  async run(ctx: SetupContext, opts: SetupRunOptions = {}): Promise<void> {
    const record = opts.record ?? (() => {});
    console.log(`\n${this.title} setup\n`);
    console.log(
      "MemPalace is a local-first memory system (https://github.com/MemPalace/mempalace).",
    );
    console.log("Its MCP server is stdio-only, so daedalus runs it as the `mempalace` container");
    console.log("(mcp-proxy fronting it); every agent reaches it over the daedalus network.\n");

    const config = loadConfig(ctx.configPath);

    const palaceRes = await prompts({
      type: "text",
      name: "palace",
      message: "Palace directory on the host (bind-mounted into the container as /palace):",
      initial: path.join(os.homedir(), ".daedalus", "mempalace"),
    });
    const palace = (palaceRes.palace as string | undefined)?.trim();
    if (!palace) throw new Error("cancelled");

    const tokenRaw = await secretPrompt({
      message:
        "Auth token (optional — only enforced if you front mcp-proxy with auth; blank = none):",
    });
    const token = ((tokenRaw as string | undefined) ?? "").trim();

    const enableBrainSync = await confirm(
      "Enable periodic brain-repo memory snapshots? (writes daily files to <brain>/memory/<YYYY-MM-DD>/)",
      false,
    );
    let schedule = "0 */6 * * *";
    if (enableBrainSync) {
      const sRes = await prompts({
        type: "text",
        name: "schedule",
        message: "Cron schedule for snapshots:",
        initial: schedule,
      });
      schedule = (sRes.schedule as string | undefined)?.trim() || schedule;
    }

    const proceed = await confirm("Proceed and wire MemPalace?", true);
    if (!proceed) throw new Error("cancelled");

    if (token) await upsertEnvFile(ctx.envPath, { MEMPALACE_TOKEN: token });

    await fs.access(ctx.configPath);
    await editYamlFile(ctx.configPath, (doc) => {
      setIn(doc, ["memory", "backend"], "mempalace");
      if (enableBrainSync) {
        setIn(doc, ["memory", "brainSync", "enabled"], true);
        setIn(doc, ["memory", "brainSync", "schedule"], schedule);
      }
      // The built-in auto-inject builds memory -> http://mempalace:11364/mcp from these.
      setIn(doc, ["mempalace", "localHttp", "enabled"], true);
      setIn(doc, ["mempalace", "localHttp", "host"], "mempalace");
      setIn(doc, ["mempalace", "localHttp", "port"], 11364);
      setIn(doc, ["mempalace", "localHttp", "urlPath"], "/mcp");
      // No host daemon — drop any stale launch command from an older host-mode setup.
      deleteIn(doc, ["mempalace", "localHttp", "command"]);
      deleteIn(doc, ["mempalace", "localHttp", "args"]);
    });

    // Rely on the auto-inject; an explicit memory/mempalace def would override it.
    // (Also cleans up a def left by an older host-mode setup.)
    const mcpCfg =
      config.mcp.configPath ?? path.join(config.brain.path, "mcp", "servers.json");
    await removeMcpServer(mcpCfg, "memory").catch(() => undefined);
    await removeMcpServer(mcpCfg, "mempalace").catch(() => undefined);

    console.log(
      `\n✓ memory.backend = mempalace\n` +
        `✓ Wired memory → http://mempalace:11364/mcp (auto-injected into every agent)\n` +
        (token ? `✓ Saved MEMPALACE_TOKEN\n` : "") +
        (enableBrainSync ? `✓ Enabled brain-sync (schedule: ${schedule})\n` : "") +
        `\nBring up the container with your palace mounted:\n` +
        `  1. In your docker-compose .env:  MEMPALACE_PALACE_PATH=${palace}\n` +
        `  2. docker compose up -d mempalace\n`,
    );
    record(`memory backend set to mempalace (docker container, palace ${palace})`);
    if (token) record("MEMPALACE_TOKEN saved via secrets backend");
    if (enableBrainSync) record(`brain-sync scheduled (${schedule})`);
  },

  async disable(ctx: SetupContext, opts: DisableOptions): Promise<void> {
    if (!opts.yes && opts.purge) {
      const ok = await confirm(
        "Purge will remove the MemPalace MCP entry, set memory.backend = none, and disable brain-sync. Stored memory data on disk is NOT touched. Continue?",
        false,
      );
      if (!ok) throw new Error("cancelled");
    }

    const config = loadConfig(ctx.configPath);
    const mcpConfigPath = config.mcp.configPath ?? path.join(config.brain.path, "mcp", "servers.json");

    // Always remove the MCP entry (no point leaving a disabled MCP server in the config —
    // the runner doesn't have a per-server enable flag, only the memory.backend toggle).
    // Handle both the current `memory` name and the legacy `mempalace` name.
    for (const serverName of ["memory", "mempalace"]) {
      if (await hasMcpServer(mcpConfigPath, serverName)) {
        await removeMcpServer(mcpConfigPath, serverName);
        console.log(`✓ Removed '${serverName}' from ${path.relative(process.cwd(), mcpConfigPath)}`);
      }
    }

    // YAML toggles via the shared helper so output messages stay consistent.
    await persistChannelDisable({
      configPath: ctx.configPath,
      envPath: ctx.envPath,
      channelId: "mempalace",
      yamlSets: opts.purge
        ? []
        : [
            { keyPath: ["memory", "backend"], value: "none" },
            { keyPath: ["memory", "brainSync", "enabled"], value: false },
            // Also flag the container connection as disabled so the auto-inject stops.
            { keyPath: ["mempalace", "localHttp", "enabled"], value: false },
          ],
      yamlPurge: [["memory"], ["mempalace"]],
      // Local-http installs may have stored a bearer token; purge it too.
      secretsToPurge: ["MEMPALACE_TOKEN"],
      purge: opts.purge,
      backend: await backendForDisable(ctx),
    });

    if (!opts.purge) {
      console.log(
        "\nNote: persisted memory data on disk (ChromaDB store, mempalace SQLite) is untouched.\n" +
          "If you want a clean slate, delete the palace directory MemPalace was using.\n",
      );
    }

    // Drop the brain-sync subtree on purge so the YAML is symmetric.
    if (opts.purge) {
      await editYamlFile(ctx.configPath, (doc) => {
        deleteIn(doc, ["memory", "brainSync"]);
      });
    }
  },
};
