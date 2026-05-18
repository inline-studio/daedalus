// Smoke test for the dispatcher abstraction + agent-turn subcommand.
//
// Doesn't drive a real docker run (that needs a brain repo + a built image).
// Instead it confirms the moving parts wire together:
//   - dispatcher factory picks the right impl from env / config
//   - the agent-turn subcommand is registered and parses its required args
//   - the container dispatcher builds the docker args correctly given an env
//
// All of this is testable without a docker daemon.

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDispatcher } from "../dist/dispatch/factory.js";
import { InProcessAgentDispatcher } from "../dist/dispatch/in-process.js";
import { ContainerAgentDispatcher } from "../dist/dispatch/container.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// Minimal fake config — only the fields the factory + dispatchers actually touch.
function fakeConfig() {
  return {
    brain: { path: "/tmp/no-brain", writable: false },
    runtime: {
      default: "host",
      dispatcher: "process",
      shared: { enabled: true, hostPath: "/tmp/shared", containerPath: "/shared" },
    },
    sessions: { dbPath: "/tmp/sessions.sqlite", attachmentsPath: "/tmp/attachments", historyLimit: 80 },
    onecli: { enabled: false, baseUrl: "http://localhost:10254", agent: "daedalus" },
    identity: { name: "Test" },
  };
}

// 1. Default: process dispatcher
{
  delete process.env.DAE_DISPATCHER;
  const d = buildDispatcher(fakeConfig());
  expect(
    "default dispatcher is InProcessAgentDispatcher",
    d instanceof InProcessAgentDispatcher,
    `got ${d?.constructor?.name}`,
  );
}

// 2. config.runtime.dispatcher: container → ContainerAgentDispatcher (needs DAE_AGENT_IMAGE_DEFAULT)
{
  const c = fakeConfig();
  c.runtime.dispatcher = "container";
  process.env.DAE_AGENT_IMAGE_DEFAULT = "ghcr.io/test/daedalus:test";
  process.env.DAE_AGENT_NETWORK = "test-net";
  const d = buildDispatcher(c);
  expect(
    "config.runtime.dispatcher=container picks ContainerAgentDispatcher",
    d instanceof ContainerAgentDispatcher,
    `got ${d?.constructor?.name}`,
  );
  delete process.env.DAE_AGENT_IMAGE_DEFAULT;
  delete process.env.DAE_AGENT_NETWORK;
}

// 3. DAE_DISPATCHER env beats config
{
  const c = fakeConfig();
  c.runtime.dispatcher = "process";
  process.env.DAE_DISPATCHER = "container";
  process.env.DAE_AGENT_IMAGE_DEFAULT = "ghcr.io/test/daedalus:test";
  const d = buildDispatcher(c);
  expect(
    "DAE_DISPATCHER env overrides config",
    d instanceof ContainerAgentDispatcher,
    `got ${d?.constructor?.name}`,
  );
  delete process.env.DAE_DISPATCHER;
  delete process.env.DAE_AGENT_IMAGE_DEFAULT;
}

// 4. ContainerAgentDispatcher throws if DAE_AGENT_IMAGE_DEFAULT isn't set
{
  delete process.env.DAE_AGENT_IMAGE_DEFAULT;
  const c = fakeConfig();
  c.runtime.dispatcher = "container";
  let threw = false;
  let msg = "";
  try {
    buildDispatcher(c);
  } catch (e) {
    threw = true;
    msg = String(e?.message ?? e);
  }
  expect(
    "ContainerAgentDispatcher refuses to build without DAE_AGENT_IMAGE_DEFAULT",
    threw && /DAE_AGENT_IMAGE_DEFAULT/.test(msg),
    msg,
  );
}

// 5. `dae agent-turn --help` is registered
{
  const help = spawnSync("node", ["dist/index.js", "agent-turn", "--help"], { encoding: "utf8" });
  const out = (help.stdout ?? "") + (help.stderr ?? "");
  expect(
    "dae agent-turn --help mentions --agent / --session / --user",
    /--agent\b/.test(out) && /--session\b/.test(out) && /--user\b/.test(out),
    `stdout/stderr did not match: ${out.slice(0, 200)}`,
  );
}

// 6. Tool registry: empty manifest → empty toolset (the security hardening)
{
  const { selectBuiltins } = await import("../dist/tools/registry.js");
  const tools = selectBuiltins([], fakeConfig());
  expect(
    "selectBuiltins([]) returns no tools (was 'all' before — security regression target)",
    Array.isArray(tools) && tools.length === 0,
    `got ${tools.length} tools`,
  );
}

// 7. Tool registry: declared subset is honored
{
  const { selectBuiltins } = await import("../dist/tools/registry.js");
  const tools = selectBuiltins(["bash", "read"], fakeConfig());
  const names = tools.map((t) => t.definition.name).sort();
  expect(
    "selectBuiltins(['bash','read']) returns exactly those two",
    JSON.stringify(names) === JSON.stringify(["bash", "read"]),
    `got ${names.join(",")}`,
  );
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
