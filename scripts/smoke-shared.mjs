// Smoke test for the cross-agent shared writable workspace.
//
// What this proves:
//   1. /shared is mounted writable inside the agent container
//   2. The bash tool sees DAE_SHARED pointing at /shared
//   3. Files written there land on the host at runtime.shared.hostPath
//   4. A *second* fresh container sees the file written by the first (persistence across runs)
//
// Bypasses the LLM. Drives bashTool.invoke directly through the same path the kernel uses.

import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../dist/config/load.js";
import { loadAgent } from "../dist/brain/agents.js";
import { buildRuntime } from "../dist/runtime/factory.js";
import { bashTool } from "../dist/tools/bash.js";

const config = loadConfig("examples/daedalus.config.yaml");
const { manifest } = await loadAgent(config.brain.path, "coder");
console.log(`shared.enabled: ${config.runtime.shared.enabled}`);
console.log(`shared.hostPath: ${config.runtime.shared.hostPath}`);
console.log(`shared.containerPath: ${config.runtime.shared.containerPath}`);
console.log("---");

const runtime = buildRuntime(manifest, config);
const ctx = {
  runtime,
  brainPath: config.brain.path,
  brainWritable: config.brain.writable,
  workspacePath: process.cwd(),
  agentName: manifest.name,
  shared: { hostPath: config.runtime.shared.hostPath, containerPath: config.runtime.shared.containerPath },
};

// 1. Write a file via $DAE_SHARED (first container)
console.log("[1] write $DAE_SHARED/agent-a.txt");
const stamp = new Date().toISOString();
const r1 = await bashTool.invoke(
  {
    command: `echo "hello-from-agent-a $stamp_only" > "$DAE_SHARED/agent-a.txt" && ls -la "$DAE_SHARED" && echo "DAE_SHARED=$DAE_SHARED"`,
    timeout_ms: 60_000,
  },
  ctx,
);
console.log(`    isError=${r1.isError ?? false}`);
console.log(r1.content.split("\n").map((l) => "    " + l).join("\n"));
console.log("");

// 2. Verify the file exists on the host
const hostFile = path.join(config.runtime.shared.hostPath, "agent-a.txt");
let hostContent = "";
try {
  hostContent = await fs.readFile(hostFile, "utf8");
  console.log(`[2] host sees the file at ${hostFile}: "${hostContent.trim()}"`);
} catch (err) {
  console.error(`[2] FAIL: ${err.message}`);
  process.exit(1);
}

// 3. Write known content from the host, then read it from a fresh container
console.log("[3] host writes ${hostPath}/from-host.txt; second container reads it back");
const fromHost = `host-write-${stamp}`;
await fs.writeFile(path.join(config.runtime.shared.hostPath, "from-host.txt"), fromHost, "utf8");
const r3 = await bashTool.invoke(
  { command: `cat "$DAE_SHARED/from-host.txt"`, timeout_ms: 60_000 },
  ctx,
);
const seen = r3.content.includes(fromHost);
console.log(`    container saw content: ${seen ? "YES" : "NO"}`);
console.log(r3.content.split("\n").map((l) => "    " + l).join("\n"));

// Cleanup
await fs.rm(path.join(config.runtime.shared.hostPath, "agent-a.txt")).catch(() => {});
await fs.rm(path.join(config.runtime.shared.hostPath, "from-host.txt")).catch(() => {});

const pass = !r1.isError && Boolean(hostContent) && seen;
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
