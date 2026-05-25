import type { ArtemisConfig } from "../config/schema.js";
import { loadMcpConfig, type McpServerMap } from "./loader.js";
import { connectMcpServer, type ConnectedServer } from "./client.js";
import { log } from "../log.js";

// Resolve the set of MCP server definitions a given agent should connect to:
//   - everything it declares (or all of them for the `*` wildcard)
//   - PLUS the auto-injected Graphiti memory HTTP MCP ("memory") when enabled,
//     so every agent gets memory by default.
// Pure (no connections) so both the one-shot connector and the persistent pool can
// share the selection logic.
export async function resolveAgentMcpDefs(
  config: ArtemisConfig,
  declared: string[],
): Promise<McpServerMap> {
  const allDefs = await loadMcpConfig(config.mcp.configPath);

  // Merge in the implicit Graphiti memory MCP if enabled (takes the `memory` slot), so
  // every agent gets memory by default without an explicit MCP entry.
  const gr = config.graphiti;
  if (gr?.enabled && !allDefs["memory"]) {
    allDefs["memory"] = { url: gr.url, transport: "http", args: [], env: {}, headers: {} };
  }

  // `mcpServers: ['*']` expands to every server in the mcp config. Subagents
  // typically declare a specific subset; the orchestrator can take everything.
  const expanded = declared.includes("*") ? Object.keys(allDefs) : declared;
  // Union: agent's declared + implicit "memory" (every agent gets memory by default).
  const wanted = new Set<string>(expanded);
  if (allDefs["memory"]) wanted.add("memory");

  const out: McpServerMap = {};
  for (const name of wanted) {
    const def = allDefs[name];
    if (!def) {
      log.warn({ name }, "MCP server requested but not found in mcp config");
      continue;
    }
    out[name] = def;
  }
  return out;
}

// Connect each MCP server this agent declares, fresh. The caller owns the returned
// connections and must close them when the turn ends. Used by the one-shot
// `dae agent-turn` container path (a new process per turn).
export async function connectAgentMcp(
  config: ArtemisConfig,
  declared: string[],
): Promise<Map<string, ConnectedServer>> {
  const defs = await resolveAgentMcpDefs(config, declared);
  const out = new Map<string, ConnectedServer>();
  for (const [name, def] of Object.entries(defs)) {
    try {
      out.set(name, await connectMcpServer(name, def));
    } catch (err) {
      log.error({ name, err }, "MCP connection failed");
    }
  }
  return out;
}

// A persistent pool of MCP connections, keyed by server name. Used by the long-lived
// `dae agent-worker`: connections are opened once and reused across turns instead of
// reconnecting (and tearing down) every turn. Concurrent first-time gets of the same
// server share a single connect via the cached promise.
export class McpPool {
  private pool = new Map<string, Promise<ConnectedServer>>();

  // Return the subset of warm connections this agent needs, connecting any that
  // aren't already in the pool. Connections stay open (the caller must NOT close
  // them — the pool owns their lifetime).
  async getForAgent(
    config: ArtemisConfig,
    declared: string[],
  ): Promise<Map<string, ConnectedServer>> {
    const defs = await resolveAgentMcpDefs(config, declared);
    const out = new Map<string, ConnectedServer>();
    for (const [name, def] of Object.entries(defs)) {
      let p = this.pool.get(name);
      if (!p) {
        p = connectMcpServer(name, def);
        this.pool.set(name, p);
      }
      try {
        out.set(name, await p);
      } catch (err) {
        // Don't cache a failed connect — evict so the next turn retries.
        log.error({ name, err }, "MCP connection failed");
        this.pool.delete(name);
      }
    }
    return out;
  }

  async closeAll(): Promise<void> {
    const promises = [...this.pool.values()];
    this.pool.clear();
    for (const p of promises) {
      try {
        await (await p).close().catch(() => undefined);
      } catch {
        /* connect itself failed; nothing to close */
      }
    }
  }
}
