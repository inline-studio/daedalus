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
import { ContainerAgentDispatcher, buildContainerArgs } from "../dist/dispatch/container.js";

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
      dispatcher: "process",
      shared: { enabled: true, hostPath: "/tmp/shared", containerPath: "/shared" },
    },
    sessions: { dbPath: "/tmp/sessions.sqlite", attachmentsPath: "/tmp/attachments", historyLimit: 80 },
    onecli: { enabled: false, baseUrl: "http://localhost:10254", agent: "daedalus" },
    identity: { name: "Test" },
    skills: { learning: { enabled: false, writeApproval: true, minToolCalls: 5, nudgeInterval: 10, maxReviewTurns: 6, curator: { enabled: false, schedule: "0 4 * * 0", staleAfterDays: 30, archiveAfterDays: 90 } } },
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

// 7b. Explicit-only tools (skill_manage): excluded from the wildcard, but naming one
// NEXT to the wildcard is a deliberate grant — `tools: ['*', 'skill_manage']`.
{
  const { selectBuiltins } = await import("../dist/tools/registry.js");
  const wild = selectBuiltins(["*"], fakeConfig()).map((t) => t.definition.name);
  expect("wildcard alone excludes skill_manage", !wild.includes("skill_manage"), wild.join(","));
  const wildPlus = selectBuiltins(["*", "skill_manage"], fakeConfig()).map((t) => t.definition.name);
  expect(
    "wildcard + explicit name grants skill_manage on top of everything",
    wildPlus.includes("skill_manage") && wildPlus.includes("bash"),
    wildPlus.join(","),
  );
  const explicit = selectBuiltins(["skill_manage"], fakeConfig()).map((t) => t.definition.name);
  expect("explicit-only selection works alone", JSON.stringify(explicit) === '["skill_manage"]');
}

// 8. ContainerAgentDispatcher: when DAE_AGENT_RUNTIME_VOLUME is set, the dispatch
// args include the runtime bind-mount, the entrypoint override, AND DO NOT
// prepend `dae` (the shim handles that). This is the "user image is third-party"
// path that lets any glibc image work without Node/daedalus pre-installed.
{
  const opts = {
    defaultImage: "ghcr.io/test/daedalus:test",
    network: "daedalus",
    hostBrainPath: "/host/brain",
    hostSharedPath: "/host/shared",
    hostDataPath: "/host/data",
    hostConfigDir: "/host/etc",
    runtimeVolume: "daedalus_dae-runtime",
  };
  const args = buildContainerArgs({
    containerName: "dae-test-abc",
    image: "python:3.12-slim",
    dispatchArgs: { agentName: "vector", sessionId: "sess1", userId: "user1", isSubagent: true },
    opts,
    brainWritable: false,
    mountDockerSock: false,
    limits: { memory: "1g", cpus: "1", pidsLimit: 512 },
  });
  expect(
    "runtime mount present",
    args.includes("-v") && args.includes("daedalus_dae-runtime:/dae-runtime:ro"),
    `args: ${args.join(" ").slice(0, 300)}`,
  );
  expect(
    "entrypoint override present",
    args.includes("--entrypoint") && args.includes("/dae-runtime/agent-turn.sh"),
  );
  expect(
    "image is the user's image, NOT the daedalus default",
    args.includes("python:3.12-slim"),
  );
  expect(
    "dae prefix is NOT present (the shim is the binary)",
    !args.includes("dae"),
    `args: ${args.join(" ")}`,
  );
  expect(
    "agent-turn args land directly after the image",
    args.lastIndexOf("python:3.12-slim") + 1 === args.indexOf("agent-turn"),
  );
  expect(
    "--subagent flag present for subagent dispatch",
    args.includes("--subagent"),
  );
  expect(
    "DAE_AGENT_RUNTIME_VOLUME env propagated to nested subagent containers",
    args.some((v, i) => args[i - 1] === "-e" && v.startsWith("DAE_AGENT_RUNTIME_VOLUME=")),
  );
}

// 9. Without runtime volume (legacy path), `dae` is prepended and no entrypoint override.
{
  const opts = {
    defaultImage: "ghcr.io/test/daedalus:test",
    network: "daedalus",
    hostBrainPath: "/host/brain",
    hostSharedPath: "/host/shared",
    hostDataPath: "/host/data",
    hostConfigDir: "/host/etc",
    // no runtimeVolume
  };
  const args = buildContainerArgs({
    containerName: "dae-test-abc",
    image: "ghcr.io/test/daedalus:test",
    dispatchArgs: { agentName: "artemis", sessionId: "s", userId: "u", isSubagent: false },
    opts,
    brainWritable: false,
    mountDockerSock: false,
    limits: { memory: "1g", cpus: "1", pidsLimit: 512 },
  });
  expect("no --entrypoint override in legacy path", !args.includes("--entrypoint"));
  expect("dae prefix present in legacy path", args.includes("dae"));
  expect("no dae-runtime mount", !args.some((s) => s.includes("/dae-runtime")));
}

// 10. forwardEnv: local-service secrets (e.g. MEMPALACE_TOKEN) get passed as -e
// into the agent container so MCP defs using ${VAR} resolve inside it.
{
  const opts = {
    defaultImage: "ghcr.io/test/daedalus:test",
    network: "daedalus",
    hostBrainPath: "/host/brain",
    hostSharedPath: "/host/shared",
    hostDataPath: "/host/data",
    hostConfigDir: "/host/etc",
    onecliApiKey: "oc_secret",
    forwardEnv: { MEMPALACE_TOKEN: "tok-123" },
  };
  const args = buildContainerArgs({
    containerName: "dae-test-fe",
    image: "ghcr.io/test/daedalus:test",
    dispatchArgs: { agentName: "artemis", sessionId: "s", userId: "u", isSubagent: false },
    opts,
    brainWritable: false,
    mountDockerSock: false,
    limits: { memory: "1g", cpus: "1", pidsLimit: 512 },
  });
  // SEC-09: secrets are forwarded by NAME (-e KEY), value supplied via the dispatcher's env,
  // so no secret value ever appears in the world-readable docker argv.
  expect(
    "SEC-09: MEMPALACE_TOKEN forwarded by name (-e MEMPALACE_TOKEN)",
    args.some((v, i) => args[i - 1] === "-e" && v === "MEMPALACE_TOKEN"),
    `args: ${args.join(" ").slice(0, 300)}`,
  );
  expect(
    "SEC-09: ONECLI_API_KEY forwarded by name (-e ONECLI_API_KEY)",
    args.some((v, i) => args[i - 1] === "-e" && v === "ONECLI_API_KEY"),
  );
  expect(
    "SEC-09: no secret VALUES appear in the argv",
    !args.some((v) => v.includes("tok-123") || v.includes("oc_secret")),
    `args: ${args.join(" ")}`,
  );
}

// 11. SEC-02: the host docker socket is mounted ONLY when mountDockerSock is true (agents
// that spawn subagents). Leaf agents must not get it — that's the blast-radius reduction.
{
  const opts = {
    defaultImage: "ghcr.io/test/daedalus:test",
    network: "daedalus",
    hostBrainPath: "/host/brain",
    hostSharedPath: "/host/shared",
    hostDataPath: "/host/data",
    hostConfigDir: "/host/etc",
  };
  const base = {
    containerName: "dae-sock",
    image: "ghcr.io/test/daedalus:test",
    dispatchArgs: { agentName: "artemis", sessionId: "s", userId: "u", isSubagent: false },
    opts,
    brainWritable: false,
    limits: { memory: "1g", cpus: "1", pidsLimit: 512 },
  };
  const withSock = buildContainerArgs({ ...base, mountDockerSock: true });
  const withoutSock = buildContainerArgs({ ...base, mountDockerSock: false });
  expect(
    "docker.sock mounted when mountDockerSock=true (spawning agent)",
    withSock.includes("/var/run/docker.sock:/var/run/docker.sock"),
  );
  expect(
    "docker.sock NOT mounted when mountDockerSock=false (leaf agent)",
    !withoutSock.includes("/var/run/docker.sock:/var/run/docker.sock"),
  );
}

// 12. SEC-03: every agent container is hardened (cap-drop ALL + no-new-privileges) and gets
// resource limits — the conservative default unless the manifest raises them.
{
  const opts = {
    defaultImage: "ghcr.io/test/daedalus:test",
    network: "daedalus",
    hostBrainPath: "/host/brain",
    hostSharedPath: "/host/shared",
    hostDataPath: "/host/data",
    hostConfigDir: "/host/etc",
  };
  const base = {
    containerName: "dae-lim",
    image: "ghcr.io/test/daedalus:test",
    dispatchArgs: { agentName: "artemis", sessionId: "s", userId: "u", isSubagent: false },
    opts,
    brainWritable: false,
    mountDockerSock: false,
  };
  // Default (conservative) limits.
  const def = buildContainerArgs({ ...base, limits: { memory: "1g", cpus: "1", pidsLimit: 512 } });
  const pair = (flag, val) => def.some((v, i) => def[i - 1] === flag && v === val);
  expect("cap-drop ALL present", pair("--cap-drop", "ALL"));
  expect("no-new-privileges present", pair("--security-opt", "no-new-privileges"));
  expect("default memory 1g", pair("--memory", "1g"));
  expect("default cpus 1", pair("--cpus", "1"));
  expect("default pids-limit 512", pair("--pids-limit", "512"));
  // Per-agent override flows through.
  const big = buildContainerArgs({ ...base, limits: { memory: "4g", cpus: "2", pidsLimit: 1024 } });
  const bigPair = (flag, val) => big.some((v, i) => big[i - 1] === flag && v === val);
  expect("override memory 4g", bigPair("--memory", "4g"));
  expect("override cpus 2", bigPair("--cpus", "2"));
  expect("override pids-limit 1024", bigPair("--pids-limit", "1024"));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
