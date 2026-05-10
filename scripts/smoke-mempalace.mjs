// Smoke for mempalace setup/disable. Skips the interactive setup prompts (those need a TTY)
// and exercises the MCP-config editor + the disable round-trip directly.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { upsertMcpServer, removeMcpServer, hasMcpServer } from "../dist/setup/mcp-edit.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmp = path.join(os.tmpdir(), `dae-mempalace-smoke-${Date.now()}`);
await fs.mkdir(tmp, { recursive: true });

// 1. file-mode: file doesn't exist yet, upsert creates it
const fileMode = path.join(tmp, "servers.json");
await upsertMcpServer(fileMode, "mempalace", { command: "uvx", args: ["mempalace-mcp"] });
const file1 = JSON.parse(await fs.readFile(fileMode, "utf8"));
expect("file-mode: created with mempalace entry", file1.mcpServers?.mempalace?.command === "uvx");

// 2. file-mode: upsert updates in place, doesn't clobber other servers
await upsertMcpServer(fileMode, "filesystem", { command: "npx", args: ["-y", "fs-mcp"] });
await upsertMcpServer(fileMode, "mempalace", { command: "pipx", args: ["run", "mempalace-mcp"] });
const file2 = JSON.parse(await fs.readFile(fileMode, "utf8"));
expect("file-mode: filesystem still present after second upsert", file2.mcpServers?.filesystem?.command === "npx");
expect("file-mode: mempalace updated", file2.mcpServers?.mempalace?.command === "pipx");

// 3. hasMcpServer correctly reports
expect("file-mode: hasMcpServer mempalace true", await hasMcpServer(fileMode, "mempalace"));
expect("file-mode: hasMcpServer ghost false", !(await hasMcpServer(fileMode, "ghost")));

// 4. file-mode: remove leaves siblings alone
await removeMcpServer(fileMode, "mempalace");
const file3 = JSON.parse(await fs.readFile(fileMode, "utf8"));
expect("file-mode: mempalace removed", !file3.mcpServers?.mempalace);
expect("file-mode: filesystem still present after remove", file3.mcpServers?.filesystem);

// 5. directory-mode: each server in its own file
const dirMode = path.join(tmp, "servers");
await fs.mkdir(dirMode);
await upsertMcpServer(dirMode, "mempalace", { command: "uvx", args: ["mempalace-mcp"] });
expect("dir-mode: mempalace.json exists", Boolean(await fs.stat(path.join(dirMode, "mempalace.json")).catch(() => null)));
const dirFile = JSON.parse(await fs.readFile(path.join(dirMode, "mempalace.json"), "utf8"));
expect("dir-mode: file contains mempalace entry", dirFile.mcpServers?.mempalace?.command === "uvx");

await removeMcpServer(dirMode, "mempalace");
expect("dir-mode: mempalace.json removed", !(await fs.stat(path.join(dirMode, "mempalace.json")).catch(() => null)));

// 6. End-to-end via CLI: setup --list / disable --list both mention mempalace
const setupList = spawnSync("node", ["dist/index.js", "setup", "--list"], { encoding: "utf8" });
expect("setup --list mentions mempalace", /mempalace\s+MemPalace/.test(setupList.stdout));
const disableList = spawnSync("node", ["dist/index.js", "disable", "--list"], { encoding: "utf8" });
expect("disable --list mentions mempalace", /mempalace/.test(disableList.stdout));

// 7. End-to-end disable on a synthetic config
const cfgDir = path.join(tmp, "cfg");
await fs.mkdir(cfgDir);
const cfgPath = path.join(cfgDir, "daedalus.config.yaml");
const mcpDir = path.join(cfgDir, "brain", "mcp");
await fs.mkdir(mcpDir, { recursive: true });
const synthYaml = `
brain:
  path: ${path.resolve("examples/brain").replaceAll("\\", "/")}

mcp:
  configPath: ./brain/mcp/servers.json

memory:
  backend: mempalace
  brainSync:
    enabled: true
    schedule: '0 */6 * * *'
`;
await fs.writeFile(cfgPath, synthYaml.trim() + "\n", "utf8");
await fs.writeFile(
  path.join(mcpDir, "servers.json"),
  JSON.stringify(
    { mcpServers: { mempalace: { command: "uvx", args: ["mempalace-mcp"] }, other: { command: "npx", args: ["-y", "other-mcp"] } } },
    null,
    2,
  ),
  "utf8",
);

const r1 = spawnSync("node", ["dist/index.js", "-c", cfgPath, "disable", "mempalace"], { encoding: "utf8" });
expect("disable mempalace exit 0", r1.status === 0, r1.stderr.split("\n").slice(-3).join(" / "));
const cfgAfter = await fs.readFile(cfgPath, "utf8");
expect("yaml: memory.backend → 'none'", /backend:\s*none/.test(cfgAfter));
expect("yaml: brainSync.enabled → false", /enabled:\s*false/.test(cfgAfter));
const mcpAfter = JSON.parse(await fs.readFile(path.join(mcpDir, "servers.json"), "utf8"));
expect("mcp: mempalace removed", !mcpAfter.mcpServers?.mempalace);
expect("mcp: other server preserved", mcpAfter.mcpServers?.other?.command === "npx");

// 8. --purge --yes also strips memory block
const r2 = spawnSync(
  "node",
  ["dist/index.js", "-c", cfgPath, "disable", "mempalace", "--purge", "--yes"],
  { encoding: "utf8" },
);
expect("disable --purge exit 0", r2.status === 0, r2.stderr.split("\n").slice(-3).join(" / "));
const cfgPurged = await fs.readFile(cfgPath, "utf8");
expect("yaml: memory block removed by purge", !/^memory:/m.test(cfgPurged));

await fs.rm(tmp, { recursive: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
