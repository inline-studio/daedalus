// Smoke for the remote-mempalace path. Doesn't drive the interactive prompts; it directly
// exercises:
//   1. McpServerDef accepts a `headers` map
//   2. The MCP loader's env-expansion fills ${MEMPALACE_TOKEN} in headers
//   3. upsertMcpServer can write either shape (stdio or http+headers) into the same file
//   4. Switching local → remote is idempotent — same key gets replaced, siblings preserved

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { upsertMcpServer, hasMcpServer } from "../dist/setup/mcp-edit.js";
import { loadMcpConfig } from "../dist/mcp/loader.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmp = path.join(os.tmpdir(), `dae-mempalace-remote-${Date.now()}`);
await fs.mkdir(tmp, { recursive: true });
const cfgPath = path.join(tmp, "servers.json");

// 1. Local entry first (simulates a prior `dae setup mempalace` in local mode)
await upsertMcpServer(cfgPath, "filesystem", { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"] });
await upsertMcpServer(cfgPath, "mempalace", { command: "uvx", args: ["mempalace-mcp"] });
const stage1 = JSON.parse(await fs.readFile(cfgPath, "utf8"));
expect("stage1: local mempalace entry written",   stage1.mcpServers?.mempalace?.command === "uvx");
expect("stage1: filesystem still present",        stage1.mcpServers?.filesystem?.command === "npx");

// 2. Now switch to remote mode (idempotent upsert with a different shape)
await upsertMcpServer(cfgPath, "mempalace", {
  url: "https://mempalace.example.com/mcp",
  transport: "http",
  headers: { Authorization: "Bearer ${MEMPALACE_TOKEN}" },
});
const stage2 = JSON.parse(await fs.readFile(cfgPath, "utf8"));
expect("stage2: mempalace switched to remote",  stage2.mcpServers?.mempalace?.url === "https://mempalace.example.com/mcp");
expect("stage2: mempalace.transport=http",      stage2.mcpServers?.mempalace?.transport === "http");
expect("stage2: header reference saved",        stage2.mcpServers?.mempalace?.headers?.Authorization === "Bearer ${MEMPALACE_TOKEN}");
expect("stage2: stdio fields cleared after switch", !stage2.mcpServers?.mempalace?.command);
expect("stage2: filesystem still untouched",    stage2.mcpServers?.filesystem?.command === "npx");

// 3. Loader expands ${MEMPALACE_TOKEN} in headers
process.env.MEMPALACE_TOKEN = "test-bearer-12345";
const loaded = await loadMcpConfig(cfgPath);
expect("loader: mempalace entry loaded",        Boolean(loaded.mempalace));
expect("loader: transport=http",                loaded.mempalace.transport === "http");
expect("loader: header expanded with token",    loaded.mempalace.headers?.Authorization === "Bearer test-bearer-12345");

// 4. Switch back to local — verifies idempotent in the other direction too
await upsertMcpServer(cfgPath, "mempalace", { command: "uvx", args: ["mempalace-mcp"] });
const stage3 = JSON.parse(await fs.readFile(cfgPath, "utf8"));
expect("stage3: switched back to local",        stage3.mcpServers?.mempalace?.command === "uvx");
expect("stage3: url cleared after switch back", !stage3.mcpServers?.mempalace?.url);

await fs.rm(tmp, { recursive: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
