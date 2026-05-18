import { execa } from "execa";
import prompts from "prompts";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  backendForDisable,
  confirm,
  persistChannelDisable,
  runtimeHost,
  type ChannelSetup,
  type DisableOptions,
  type SetupContext,
  type SetupRunOptions,
} from "./base.js";
import { upsertMcpServer, removeMcpServer, hasMcpServer, type McpServerEntry } from "./mcp-edit.js";
import { secretPrompt } from "./secret-prompt.js";
import { editYamlFile, setIn, deleteIn } from "./yaml-edit.js";
import { loadConfig } from "../config/load.js";
import { upsertEnvFile } from "./env-file.js";
import fs from "node:fs/promises";

const DEFAULT_COMMAND = "uvx";
const DEFAULT_ARGS = ["mempalace-mcp"];

async function isOnPath(cmd: string): Promise<boolean> {
  try {
    await execa(cmd, ["--version"], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

async function probeRemote(url: string, token?: string): Promise<string | null> {
  try {
    const headers: Record<string, string> = { Accept: "application/json,text/event-stream" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(url, { method: "GET", headers });
    // Any HTTP response is proof of life. 401/403 means auth issue (still useful feedback).
    if (res.status === 401 || res.status === 403) return `auth rejected (HTTP ${res.status})`;
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export const mempalaceSetup: ChannelSetup = {
  id: "mempalace",
  title: "MemPalace memory backend",
  summary:
    "Wire MemPalace as the persistent memory store. Adds the MCP server to your brain config, sets memory.backend, and optionally enables brain-repo memory snapshots.",

  async run(ctx: SetupContext, opts: SetupRunOptions = {}): Promise<void> {
    const record = opts.record ?? (() => {});
    console.log(`\n${this.title} setup\n`);
    console.log(
      "MemPalace is a local-first memory system (https://github.com/mempalace/mempalace).",
    );
    console.log("It exposes 29 MCP tools for storing/searching agent diaries, knowledge graphs,");
    console.log("and verbatim conversation snippets.\n");

    const config = loadConfig(ctx.configPath);

    // 1. Mode: stdio subprocess (simplest), local-HTTP daemon (network-reachable, share with
    //    other devices on your LAN), or remote (point at a mempalace already running elsewhere).
    const modeRes = await prompts({
      type: "select",
      name: "mode",
      message: "Where does MemPalace live?",
      choices: [
        { title: "local-stdio    (subprocess, this machine only — simplest)", value: "local" },
        {
          title: "local-http     (HTTP daemon on this machine — share with your other devices)",
          value: "local-http",
        },
        { title: "remote         (an already-running HTTP server elsewhere)", value: "remote" },
      ],
      initial: 0,
    });
    const mode = (modeRes.mode as "local" | "local-http" | "remote" | undefined) ?? null;
    if (!mode) throw new Error("cancelled");

    let entry: McpServerEntry;
    let envUpdates: Record<string, string> = {};
    // Captured during local-http for the post-setup remote-access panel.
    let localHttpDetails: {
      host: string;
      port: number;
      urlPath: string;
      token: string;
      command: string;
      args: string[];
    } | null = null;

    if (mode === "local") {
      process.stdout.write("checking for `uvx` on PATH… ");
      const haveUvx = await isOnPath("uvx");
      process.stdout.write(haveUvx ? "found\n\n" : "not found\n");
      if (!haveUvx) {
        console.log(
          "Install uv from https://docs.astral.sh/uv/, or use `pipx install mempalace-mcp`\n" +
            "and point this setup at the resulting binary.\n",
        );
      }
      const cmdRes = await prompts({
        type: "text",
        name: "command",
        message: "MCP server launch command:",
        initial: DEFAULT_COMMAND,
      });
      const command = (cmdRes.command as string | undefined)?.trim() ?? "";
      if (!command) throw new Error("cancelled");
      const argsRes = await prompts({
        type: "text",
        name: "args",
        message: "Arguments (space-separated):",
        initial: DEFAULT_ARGS.join(" "),
      });
      const argsText = (argsRes.args as string | undefined)?.trim() ?? "";
      const args = argsText ? argsText.split(/\s+/) : [];
      entry = { command, args };
    } else if (mode === "local-http") {
      // ─── local-http ────────────────────────────────────────────────────────────────────
      // Mempalace runs as a long-lived HTTP daemon on THIS machine, exposed on a configurable
      // port. Other devices on your network (your laptop, VS Code, Claude Desktop) connect
      // to it remotely. Pair with `dae service install mempalace` to keep it running.
      console.log(
        "\nLocal-HTTP mode: MemPalace runs as a managed daemon on this machine, exposed on a\n" +
          "port your other devices can reach. ALWAYS set a token if binding to 0.0.0.0.\n",
      );

      // Use type:text rather than type:number — prompts' number widget has a
      // known quirk where pressing Enter on the initial value can return
      // undefined instead of the default, causing the wizard to crash on
      // "cancelled" when the user just wanted to accept 11364. Text + numeric
      // validate behaves identically to every other prompt in the wizard.
      const portRes = await prompts({
        type: "text",
        name: "port",
        message: "Port (each MCP server on this host needs its own):",
        initial: "11364",
        validate: (v: string) => {
          const n = Number(v);
          return Number.isInteger(n) && n > 0 && n <= 65535 || "must be a valid port (1-65535)";
        },
      });
      const portStr = (portRes.port as string | undefined)?.trim() ?? "";
      if (!portStr) throw new Error("cancelled");
      const port = Number(portStr);

      const hostRes = await prompts({
        type: "select",
        name: "host",
        message: "Bind address:",
        choices: [
          { title: "127.0.0.1 (this machine only — safest, requires SSH tunnel for remote use)", value: "127.0.0.1" },
          { title: "0.0.0.0 (all interfaces — reachable from your LAN; auth strongly recommended)", value: "0.0.0.0" },
        ],
        initial: 0,
      });
      const host = (hostRes.host as string | undefined) ?? "127.0.0.1";

      const urlPathRes = await prompts({
        type: "text",
        name: "urlPath",
        message: "URL path the MCP transport listens on:",
        initial: "/mcp",
      });
      const urlPath = ((urlPathRes.urlPath as string | undefined) ?? "/mcp").replace(/^\/?/, "/");

      let token = ((await secretPrompt({
        message: "Auth token (leave blank to auto-generate a strong one):",
      })) ?? "").trim();
      if (!token) token = crypto.randomBytes(32).toString("hex");

      console.log(
        "\nMemPalace's HTTP launch flags can vary by version. The default below is a guess —\n" +
          "edit if your installed version uses different ones. The runner doesn't validate the\n" +
          "command works; the service-install step does that when it actually starts the daemon.\n",
      );
      const cmdRes = await prompts({
        type: "text",
        name: "command",
        message: "MemPalace launch command:",
        initial: "uvx",
      });
      const command = (cmdRes.command as string | undefined)?.trim() ?? "uvx";
      const argsRes = await prompts({
        type: "text",
        name: "args",
        message: "Arguments:",
        initial: `mempalace-mcp --transport http --host ${host} --port ${port}`,
      });
      const argsText = (argsRes.args as string | undefined)?.trim() ?? "";
      const launchArgs = argsText ? argsText.split(/\s+/) : [];

      // The MCP entry the runner uses to connect to mempalace. When runtime is docker the
      // runner (or its agents) reach the host via host.docker.internal, not 127.0.0.1.
      // Note: if runtime is docker, mempalace must bind to 0.0.0.0 to be reachable.
      const localUrl = `http://${runtimeHost(ctx.configPath)}:${port}${urlPath}`;
      entry = {
        url: localUrl,
        transport: "http",
        headers: { Authorization: "Bearer ${MEMPALACE_TOKEN}" },
      };
      envUpdates.MEMPALACE_TOKEN = token;
      localHttpDetails = { host, port, urlPath, token, command, args: launchArgs };
    } else {
      console.log(
        "\nRemote mode: MemPalace is hosted somewhere reachable over HTTP. Point the runner at\n" +
          "its MCP endpoint. If the server requires auth, paste a bearer token — it'll be saved\n" +
          "via the configured secrets backend (OneCLI if enabled; otherwise .env.local).\n",
      );
      const urlRes = await prompts({
        type: "text",
        name: "url",
        message: "MemPalace MCP URL (e.g. https://mempalace.in-line.studio/mcp):",
        validate: (v: string) => /^https?:\/\//.test(v) || "must be an http(s) URL",
      });
      const url = (urlRes.url as string | undefined)?.trim() ?? "";
      if (!url) throw new Error("cancelled");

      const transportRes = await prompts({
        type: "select",
        name: "transport",
        message: "Transport:",
        choices: [
          { title: "http (Streamable HTTP — recommended)", value: "http" },
          { title: "sse (legacy server-sent events)", value: "sse" },
        ],
        initial: 0,
      });
      const transport = (transportRes.transport as "http" | "sse" | undefined) ?? "http";

      const token = ((await secretPrompt({
        message: "Bearer token (leave blank if the server is unauthenticated):",
      })) ?? "").trim();

      // Probe — fast feedback on URL typos / unreachable hosts.
      process.stdout.write(`probing ${url}… `);
      const probeErr = await probeRemote(url, token || undefined);
      process.stdout.write(probeErr ? `WARN (${probeErr})\n` : "OK\n");
      if (probeErr) {
        const ok = await confirm("Save anyway? (use this if the server isn't up yet)", false);
        if (!ok) throw new Error("cancelled");
      }

      entry = {
        url,
        transport,
        ...(token
          ? { headers: { Authorization: "Bearer ${MEMPALACE_TOKEN}" } }
          : {}),
      };
      if (token) envUpdates.MEMPALACE_TOKEN = token;
    }

    // 2. Where in the MCP config to write. If unset, default to <brain>/mcp/servers.json.
    let mcpConfigPath = config.mcp.configPath;
    if (!mcpConfigPath) {
      mcpConfigPath = path.join(config.brain.path, "mcp", "servers.json");
      console.log(`mcp.configPath not set; writing to ${path.relative(process.cwd(), mcpConfigPath)} (auto-discovered).`);
    } else {
      console.log(`writing to MCP config at ${path.relative(process.cwd(), mcpConfigPath)}`);
    }

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

    const proceed = await confirm(`Proceed and wire MemPalace (${mode})?`, true);
    if (!proceed) throw new Error("cancelled");

    // 3. Write secrets (token), MCP entry, then YAML edits.
    if (Object.keys(envUpdates).length > 0) {
      await upsertEnvFile(ctx.envPath, envUpdates);
    }
    await upsertMcpServer(mcpConfigPath, "mempalace", entry);

    // 2. YAML edits — memory.backend + optional brain-sync + local-http daemon settings
    await fs.access(ctx.configPath);
    await editYamlFile(ctx.configPath, (doc) => {
      setIn(doc, ["memory", "backend"], "mempalace");
      if (enableBrainSync) {
        setIn(doc, ["memory", "brainSync", "enabled"], true);
        setIn(doc, ["memory", "brainSync", "schedule"], schedule);
      }
      if (!config.mcp.configPath) {
        const rel = path.relative(path.dirname(ctx.configPath), mcpConfigPath).replaceAll("\\", "/");
        setIn(doc, ["mcp", "configPath"], rel || mcpConfigPath);
      }
      // Persist local-http daemon details so `dae service install mempalace` can spawn it.
      if (localHttpDetails) {
        setIn(doc, ["mempalace", "localHttp", "enabled"], true);
        setIn(doc, ["mempalace", "localHttp", "command"], localHttpDetails.command);
        setIn(doc, ["mempalace", "localHttp", "args"], localHttpDetails.args);
        setIn(doc, ["mempalace", "localHttp", "host"], localHttpDetails.host);
        setIn(doc, ["mempalace", "localHttp", "port"], localHttpDetails.port);
        setIn(doc, ["mempalace", "localHttp", "urlPath"], localHttpDetails.urlPath);
      } else {
        // Other modes shouldn't leave a stale localHttp.enabled around.
        setIn(doc, ["mempalace", "localHttp", "enabled"], false);
      }
    });

    console.log(
      `\n✓ Added 'mempalace' to ${path.relative(process.cwd(), mcpConfigPath)} (${mode})\n` +
        `✓ Set memory.backend = mempalace\n` +
        (enableBrainSync ? `✓ Enabled brain-sync (schedule: ${schedule})\n` : "") +
        (envUpdates.MEMPALACE_TOKEN ? `✓ Saved MEMPALACE_TOKEN via secrets backend\n` : "") +
        `\nAny agent that lists 'mempalace' in its mcpServers will now reach the ${mode} instance.\n`,
    );

    record(`memory backend set to mempalace (${mode})`);
    if (localHttpDetails) {
      record(`local HTTP daemon: ${localHttpDetails.host}:${localHttpDetails.port}${localHttpDetails.urlPath}`);
      record(`service: \`dae service install dae-mempalace\` to run on boot`);
    }
    if (enableBrainSync) record(`brain-sync scheduled (${schedule})`);
    if (envUpdates.MEMPALACE_TOKEN) record(`MEMPALACE_TOKEN saved via secrets backend`);

    // 3. Remote-access panel (local-http only). Print enough to copy onto another device.
    if (localHttpDetails) {
      const { host, port, urlPath, token } = localHttpDetails;
      const lanHost = os.hostname();
      const remoteHost = host === "0.0.0.0" ? lanHost : "<reachable-host-or-IP>";
      const localUrl = `http://127.0.0.1:${port}${urlPath}`;
      const remoteUrl = `http://${remoteHost}:${port}${urlPath}`;

      console.log(`\n${"─".repeat(72)}`);
      console.log("Remote access details — copy these into your other devices' MCP config");
      console.log("─".repeat(72));
      console.log(`Local URL  (this machine):     ${localUrl}`);
      console.log(`Network URL (other devices):   ${remoteUrl}`);
      console.log(`Auth token:                    ${token}`);
      console.log(`Status: bound to ${host}${host === "127.0.0.1" ? " — LAN access disabled" : ""}`);
      console.log("");
      console.log("Sample MCP config snippet for Claude Desktop / VS Code MCP / OpenCode:");
      console.log("");
      console.log(JSON.stringify(
        {
          mcpServers: {
            mempalace: {
              url: remoteUrl,
              transport: "http",
              headers: { Authorization: `Bearer ${token}` },
            },
          },
        },
        null,
        2,
      ));
      console.log("");
      if (host === "127.0.0.1") {
        console.log("To make this reachable from your laptops/phones, either:");
        console.log("  • re-run setup and pick 0.0.0.0 (binds all interfaces; auth strongly recommended)");
        console.log("  • or keep 127.0.0.1 and tunnel: ssh -L 11364:127.0.0.1:11364 user@casa");
      } else {
        console.log("Bound to 0.0.0.0 — anyone with the token who can reach this machine on port");
        console.log(`${port} can read/write your memory. Don't share the token. Consider a reverse`);
        console.log("proxy with TLS (caddy/traefik/nginx) if exposing beyond your trusted LAN.");
      }
      console.log("");
      console.log("Now run:  dae service install mempalace   (so the daemon survives logout)");
      console.log("─".repeat(72));
    }
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
    if (await hasMcpServer(mcpConfigPath, "mempalace")) {
      await removeMcpServer(mcpConfigPath, "mempalace");
      console.log(`✓ Removed mempalace from ${path.relative(process.cwd(), mcpConfigPath)}`);
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
            // Also flag the local-http daemon as disabled so service-install no longer
            // pre-checks it; the user can flip back via setup later.
            { keyPath: ["mempalace", "localHttp", "enabled"], value: false },
          ],
      yamlPurge: [["memory"], ["mempalace"]],
      // Remote and local-http installs may have stored a bearer token; purge it too.
      secretsToPurge: ["MEMPALACE_TOKEN"],
      purge: opts.purge,
      backend: await backendForDisable(ctx),
    });

    if (!opts.purge) {
      console.log(
        "\nNote: persisted memory data on disk (ChromaDB store, mempalace SQLite) is untouched.\n" +
          "If you want a clean slate, delete the directories MemPalace was using directly.\n",
      );
    }

    // Also drop the YAML manipulation we made for cleanup so the YAML is symmetric — but
    // only on purge, since the default disable wants to keep enough config to re-enable.
    if (opts.purge) {
      await editYamlFile(ctx.configPath, (doc) => {
        deleteIn(doc, ["memory", "brainSync"]);
      });
    }
  },
};
