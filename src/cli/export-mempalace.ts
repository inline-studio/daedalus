import os from "node:os";
import { loadConfig } from "../config/load.js";
import { loadMcpConfig } from "../mcp/loader.js";

// `dae export mempalace` — print a paste-ready MCP config snippet for other devices
// (Claude Desktop, VS Code MCP, OpenCode, …) so they can connect to the same MemPalace
// vault. Behavior depends on which mode `dae setup mempalace` was run in:
//
//   local-stdio  → no remote use case; bail with a clear error.
//   local-http   → print local URL + LAN URL + tunnel hint + paste-ready snippet.
//                  Token comes from MEMPALACE_TOKEN (env or secrets backend, already
//                  resolved by loadConfig's env-expansion path).
//   remote       → re-print the configured URL + token. Useful if the user forgot.

export interface ExportOptions {
  hostOverride?: string;
  configPath?: string;
}

const SEP = "═".repeat(72);
const SUB = "─".repeat(72);

export async function exportMempalace(opts: ExportOptions = {}): Promise<void> {
  const config = loadConfig(opts.configPath);
  const mcpServers = await loadMcpConfig(config.mcp.configPath);
  // Current setups register the server as `memory`; older ones used `mempalace`.
  const entry = mcpServers.memory ?? mcpServers.mempalace;
  if (!entry) {
    throw new Error(
      "No 'memory' entry found in your MCP config. Run `dae setup mempalace` first.",
    );
  }

  // local-stdio has no URL — refuse with a useful message.
  if (entry.command && !entry.url) {
    throw new Error(
      "MemPalace is configured in local-stdio mode (subprocess). There's no remote URL to share —\n" +
        "subprocess-mode mempalace is only reachable from this daedalus runner. To share with other\n" +
        "devices, re-run `dae setup mempalace` and pick local-http (or remote).",
    );
  }
  if (!entry.url) {
    throw new Error("MemPalace MCP entry has no URL — config is malformed.");
  }

  const lh = config.mempalace.localHttp;
  const isLocalHttp = lh.enabled;
  const url = new URL(entry.url);
  const port = lh.enabled ? lh.port : url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const urlPath = lh.enabled ? lh.urlPath : url.pathname || "/";

  // The token reference looks like "Bearer ${MEMPALACE_TOKEN}" in the entry; the loader's
  // env-expansion already resolved it. Read the literal value from process.env (which the
  // config-load path populated) so we can print the actual token.
  const authHeader = entry.headers?.Authorization ?? "";
  const tokenMatch = authHeader.match(/^Bearer\s+(.+)$/);
  const token = tokenMatch?.[1] ?? "";

  // Decide what URL to suggest other devices use.
  let suggestedRemoteUrl: string;
  let networkNote: string;

  if (isLocalHttp) {
    // Local-HTTP: bound to 127.0.0.1 = needs tunnel; 0.0.0.0 = use a hostname/IP.
    if (lh.host === "0.0.0.0") {
      const hostname = opts.hostOverride ?? os.hostname();
      suggestedRemoteUrl = `http://${hostname}:${port}${urlPath}`;
      networkNote = `Bound to 0.0.0.0 — reachable on your LAN at ${hostname} (override with --host).`;
    } else {
      suggestedRemoteUrl = `http://127.0.0.1:${port}${urlPath}`;
      networkNote =
        `Bound to 127.0.0.1 — only this machine can reach the daemon directly. To use it\n` +
        `from another device, open an SSH tunnel:\n` +
        `  ssh -L ${port}:127.0.0.1:${port} <user>@<this-host>\n` +
        `…and use http://127.0.0.1:${port}${urlPath} on the other device.`;
    }
  } else {
    // Remote mode: reuse the URL the user configured.
    suggestedRemoteUrl = entry.url;
    networkNote = `Remote mode — the URL above is what you originally entered during setup.`;
  }

  console.log(`\n${SEP}`);
  console.log(`MemPalace MCP — paste into your other devices`);
  console.log(SEP);
  console.log(`Mode:        ${isLocalHttp ? "local-http (this machine is hosting)" : "remote"}`);
  if (isLocalHttp) {
    console.log(`Bound to:    ${lh.host}`);
    console.log(`Port:        ${lh.port}`);
    console.log(`URL path:    ${lh.urlPath}`);
    console.log("");
    console.log(`Suggested URLs:`);
    console.log(`  • From this machine:        http://127.0.0.1:${port}${urlPath}`);
    console.log(`  • From devices on your LAN: ${suggestedRemoteUrl}`);
  } else {
    console.log(`URL:         ${entry.url}`);
  }
  console.log("");
  console.log(networkNote);
  console.log("");

  if (token) {
    console.log(`Auth token:  ${token}`);
  } else {
    console.log(`Auth token:  (none — server is unauthenticated)`);
  }
  console.log("");
  console.log(`Paste this on each client device:`);
  console.log("");
  const snippet = {
    mcpServers: {
      memory: {
        url: suggestedRemoteUrl,
        transport: entry.transport ?? "http",
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
      },
    },
  };
  console.log(indent(JSON.stringify(snippet, null, 2), 2));
  console.log("");
  console.log(`Where to paste:`);
  console.log(`  • Claude Desktop (mac):     ~/Library/Application Support/Claude/claude_desktop_config.json`);
  console.log(`  • Claude Desktop (windows): %APPDATA%\\Claude\\claude_desktop_config.json`);
  console.log(`  • VS Code MCP extension:    .vscode/mcp.json (or extension settings)`);
  console.log(`  • OpenCode:                 ~/.config/opencode/mcp.json`);
  console.log("");
  if (token) {
    console.log(`${SUB}`);
    console.log(`⚠ The token above is a secret. Don't paste this output into chat, screenshots, or git.`);
    console.log(SUB);
  }
}

function indent(s: string, n: number): string {
  const pad = " ".repeat(n);
  return s
    .split("\n")
    .map((l) => pad + l)
    .join("\n");
}
