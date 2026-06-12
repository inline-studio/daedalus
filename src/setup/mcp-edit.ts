import fs from "node:fs/promises";
import path from "node:path";
import { atomicWrite } from "./atomic-write.js";

// Add or replace an MCP server entry in the configured MCP config.
// `configPath` may be a file (Claude-Desktop-style mcpServers map) or a directory of *.json
// files (one server per file). Idempotent — re-running with the same name updates in place.
export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  transport?: "stdio" | "http" | "sse";
  // Custom HTTP headers (http/sse only). Values may include ${VAR} env references —
  // they're expanded by the runner at config-load time.
  headers?: Record<string, string>;
  cwd?: string;
}

export async function upsertMcpServer(
  configPath: string,
  name: string,
  entry: McpServerEntry,
): Promise<void> {
  const stat = await fs.stat(configPath).catch(() => null);

  if (stat?.isDirectory()) {
    const file = path.join(configPath, `${name}.json`);
    const json = { mcpServers: { [name]: entry } };
    await atomicWrite(file, JSON.stringify(json, null, 2) + "\n");
    return;
  }

  // File mode (or doesn't exist yet — create it).
  let doc: { mcpServers?: Record<string, McpServerEntry>; servers?: Record<string, McpServerEntry> } = {};
  if (stat?.isFile()) {
    const raw = await fs.readFile(configPath, "utf8");
    if (raw.trim()) {
      try {
        doc = JSON.parse(raw);
      } catch (err) {
        // IMP-04: don't silently reset a non-empty-but-malformed MCP config to {} — that would
        // wipe every existing server on the next upsert. Surface it so the operator fixes it.
        throw new Error(`MCP config at ${configPath} is not valid JSON: ${(err as Error).message}`);
      }
    }
  }
  const map = doc.mcpServers ?? doc.servers ?? {};
  map[name] = entry;
  doc.mcpServers = map;
  delete doc.servers;
  await atomicWrite(configPath, JSON.stringify(doc, null, 2) + "\n");
}

export async function removeMcpServer(configPath: string, name: string): Promise<void> {
  const stat = await fs.stat(configPath).catch(() => null);
  if (!stat) return; // nothing to remove

  if (stat.isDirectory()) {
    const file = path.join(configPath, `${name}.json`);
    await fs.rm(file).catch(() => undefined);
    return;
  }

  let doc: { mcpServers?: Record<string, McpServerEntry>; servers?: Record<string, McpServerEntry> };
  try {
    doc = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return;
  }
  const map = doc.mcpServers ?? doc.servers;
  if (!map) return;
  if (!(name in map)) return;
  delete map[name];
  doc.mcpServers = map;
  delete doc.servers;
  await atomicWrite(configPath, JSON.stringify(doc, null, 2) + "\n");
}

export async function hasMcpServer(configPath: string, name: string): Promise<boolean> {
  const stat = await fs.stat(configPath).catch(() => null);
  if (!stat) return false;
  if (stat.isDirectory()) {
    const file = path.join(configPath, `${name}.json`);
    return Boolean(await fs.stat(file).catch(() => null));
  }
  try {
    const doc = JSON.parse(await fs.readFile(configPath, "utf8")) as {
      mcpServers?: Record<string, unknown>;
      servers?: Record<string, unknown>;
    };
    const map = doc.mcpServers ?? doc.servers ?? {};
    return name in map;
  } catch {
    return false;
  }
}
