// Agent-in-container smoke test (no LLM required).
//
// Exercises the same code path the kernel uses when the LLM emits a `bash` tool call:
//   loadConfig → loadAgent → buildRuntime → bashTool.invoke
//
// What we prove:
//   - the coder agent's container manifest is parsed correctly
//   - the runtime factory produces a DockerRuntime (not a HostRuntime)
//   - the brain is auto-mounted at /brain, read-only
//   - the bash tool routes commands into the container
//
// Run with:  node scripts/smoke-agent-container.mjs
//
// Bypasses the LLM entirely. To verify the full LLM → tool_use → container loop, set
// ANTHROPIC_API_KEY and run:  node dist/index.js -c examples/daedalus.config.yaml run coder
//   --prompt "Run 'cat /etc/os-release && uname -a' and report exactly what you see"

import { loadConfig } from "../dist/config/load.js";
import { loadAgent } from "../dist/brain/agents.js";
import { buildRuntime } from "../dist/runtime/factory.js";
import { bashTool } from "../dist/tools/bash.js";

const config = loadConfig("examples/daedalus.config.yaml");
const { manifest, body } = await loadAgent(config.brain.path, "coder");

console.log(`agent: ${manifest.name}`);
console.log(`container.image: ${manifest.container?.image ?? "<none>"}`);
console.log(`container.workdir: ${manifest.container?.workdir ?? "<none>"}`);
console.log(`brain.path: ${config.brain.path}`);
console.log(`brain.writable: ${config.brain.writable}`);
console.log("---");

const runtime = buildRuntime(manifest, config);
console.log(`runtime.id: ${runtime.id} (expected: docker)`);
if (runtime.id !== "docker") {
  console.error("FAIL: container manifest didn't produce a DockerRuntime");
  process.exit(1);
}

const ctx = {
  runtime,
  brainPath: config.brain.path,
  brainWritable: config.brain.writable,
  workspacePath: process.cwd(),
  agentName: manifest.name,
};

// 1. Confirm we're in Alpine (host is Windows — if this works, we're definitely in the container).
console.log("[1] cat /etc/os-release && uname -a");
const r1 = await bashTool.invoke(
  { command: "cat /etc/os-release && uname -a", timeout_ms: 90_000 },
  ctx,
);
console.log(`    isError=${r1.isError ?? false}`);
console.log(r1.content.split("\n").map((l) => "    " + l).join("\n"));
console.log("");

// 2. Confirm the brain is mounted at /brain.
console.log("[2] ls /brain");
const r2 = await bashTool.invoke({ command: "ls /brain", timeout_ms: 30_000 }, ctx);
console.log(`    isError=${r2.isError ?? false}`);
console.log(r2.content.split("\n").map((l) => "    " + l).join("\n"));
console.log("");

// 3. Confirm /brain is read-only — write must fail.
console.log("[3] touch /brain/__should_fail (must fail with read-only fs)");
const r3 = await bashTool.invoke(
  { command: "touch /brain/__should_fail.txt 2>&1; echo EXIT=$?", timeout_ms: 30_000 },
  ctx,
);
const enforced = /Read-only file system/.test(r3.content) && /EXIT=1/.test(r3.content);
console.log(`    read-only enforced: ${enforced ? "YES" : "NO"}`);
console.log(r3.content.split("\n").map((l) => "    " + l).join("\n"));
console.log("");

// 4. Confirm bash is in node:24-alpine specifically (node should be installed).
console.log("[4] node --version");
const r4 = await bashTool.invoke({ command: "node --version", timeout_ms: 30_000 }, ctx);
console.log(`    isError=${r4.isError ?? false}`);
console.log(r4.content.split("\n").map((l) => "    " + l).join("\n"));

const allOk = !r1.isError && !r2.isError && enforced && !r4.isError;
console.log(`\nresult: ${allOk ? "PASS" : "FAIL"}`);
process.exit(allOk ? 0 : 1);
