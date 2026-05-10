// Smoke test: drive DockerRuntime directly without the LLM loop.
// Run with: node scripts/smoke-docker.mjs
//
// Reads DOCKER_BIN if set; falls back to `docker`. Tries:
//   1. `docker --version`         — confirms the binary works
//   2. `docker info`              — confirms the daemon is reachable
//   3. DockerRuntime.exec on alpine — confirms argv construction is right end-to-end
//
// This script does NOT need an LLM API key. Daemon test (#3) is skipped if (#2) fails.

import { DockerRuntime } from "../dist/runtime/docker.js";
import { execa } from "execa";

const bin = process.env.DOCKER_BIN ?? "docker";

async function main() {
  console.log(`docker bin: ${bin}`);

  // 1. version
  try {
    const v = await execa(bin, ["--version"]);
    console.log(`[1] version: ${v.stdout.trim()}`);
  } catch (err) {
    console.error(`[1] FAIL: ${err.shortMessage ?? err.message}`);
    process.exit(1);
  }

  // 2. daemon reachable?
  let daemonUp = true;
  try {
    const i = await execa(bin, ["info", "--format", "{{.ServerVersion}}"]);
    console.log(`[2] daemon: ${i.stdout.trim() || "(empty)"}`);
  } catch (err) {
    daemonUp = false;
    console.error(`[2] daemon NOT reachable: ${err.shortMessage ?? err.message}`);
  }

  if (!daemonUp) {
    console.log("[3] skipped (daemon not running). Start Docker Desktop and re-run.");
    process.exit(0);
  }

  // 3. round-trip via the runtime abstraction
  const rt = new DockerRuntime({
    image: "alpine:3",
    bin,
  });
  const result = await rt.exec("echo hello-from-container && uname -a", {
    timeoutMs: 60_000,
  });
  console.log(`[3] exit=${result.exitCode}`);
  console.log(`    stdout: ${result.stdout.trim()}`);

  // 4. Read-only bind-mount enforcement.
  // Mount cwd as /brain:ro, prove writes fail; /tmp must still be writable.
  const cwd = process.cwd().replaceAll("\\", "/");
  const rtRo = new DockerRuntime({
    image: "alpine:3",
    bin,
    binds: [{ host: cwd, container: "/brain", readOnly: true }],
  });
  const denied = await rtRo.exec("touch /brain/__should_fail.txt 2>&1; echo EXIT=$?", {
    timeoutMs: 30_000,
  });
  const allowed = await rtRo.exec("touch /tmp/ok && echo writable", { timeoutMs: 30_000 });

  const wasDenied = /Read-only file system|EXIT=1/.test(denied.stdout);
  console.log(`[4a] read-only brain mount: ${wasDenied ? "ENFORCED" : "NOT ENFORCED"}`);
  console.log(`     ${denied.stdout.trim().split("\n").join(" | ")}`);
  console.log(`[4b] /tmp writable: ${allowed.stdout.trim() === "writable" ? "OK" : "FAIL"}`);

  process.exit(result.exitCode || (wasDenied ? 0 : 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
