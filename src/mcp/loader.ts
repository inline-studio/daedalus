import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { expandEnv } from "../config/load.js";

// A single MCP server definition. Compatible with the Claude Desktop schema, plus a
// `headers` field for remote servers that need bearer auth or other custom headers.
export const McpServerDefSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  // for HTTP/SSE servers
  url: z.string().url().optional(),
  transport: z.enum(["stdio", "http", "sse"]).optional(),
  // Custom HTTP headers (http/sse only). Supports env-var expansion via ${VAR}.
  // Common pattern: { "Authorization": "Bearer ${MEMPALACE_TOKEN}" }
  headers: z.record(z.string()).default({}),
  cwd: z.string().optional(),
});
export type McpServerDef = z.infer<typeof McpServerDefSchema>;

export const McpConfigFileSchema = z.object({
  // The Claude Desktop key is "mcpServers"; we accept "servers" too.
  mcpServers: z.record(McpServerDefSchema).optional(),
  servers: z.record(McpServerDefSchema).optional(),
});

export type McpServerMap = Record<string, McpServerDef>;

export async function loadMcpConfig(configPath: string | undefined): Promise<McpServerMap> {
  if (!configPath) return {};
  const stat = await fs.stat(configPath).catch(() => null);
  if (!stat) return {};

  if (stat.isDirectory()) {
    const files = (await fs.readdir(configPath)).filter((f) => f.endsWith(".json"));
    const merged: McpServerMap = {};
    for (const f of files) {
      const fp = path.join(configPath, f);
      const part = await readMcpFile(fp);
      const namespace = path.basename(f, ".json");
      // If a file has a single unnamed server, key by filename. Otherwise merge keys.
      const keys = Object.keys(part);
      if (keys.length === 0) continue;
      if (keys.length === 1 && keys[0] === "default") {
        merged[namespace] = part[keys[0]]!;
      } else {
        for (const [k, v] of Object.entries(part)) {
          if (merged[k]) {
            throw new Error(`Duplicate MCP server name '${k}' in ${fp}`);
          }
          merged[k] = v;
        }
      }
    }
    return merged;
  }

  return readMcpFile(configPath);
}

async function readMcpFile(file: string): Promise<McpServerMap> {
  const raw = JSON.parse(await fs.readFile(file, "utf8"));
  const expanded = expandEnv(raw);
  const parsed = McpConfigFileSchema.parse(expanded);
  return parsed.mcpServers ?? parsed.servers ?? {};
}
