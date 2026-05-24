// Daedalus test runner — runs the smoke battery in sequence and reports.
// Used by `npm test` and the CI workflow.
//
// We split the smokes into three buckets:
//   1. CI-safe       — pure unit/wiring; no Docker daemon, no live LLM
//   2. CLI-spawning  — slower smokes that fork the `dae` CLI but need no daemon
//   3. Needs Docker  — the runtime + agent-in-container tests
//
// The default `npm test` runs CI-safe + the CLI-spawning bucket + (optionally) Docker
// if available. Set DAE_TEST_SCOPE to control:
//   ci      → CI-safe only (default in CI; set by the workflow)
//   local   → CI-safe + CLI-spawning (default outside CI)
//   all     → run everything, including Docker-dependent tests

import { spawnSync } from "node:child_process";

const CI_SAFE = [
  "smoke-attachment-path",
  "smoke-audio-ingest",
  "smoke-commands",
  "smoke-compaction",
  "smoke-context-budget",
  "smoke-context-trim",
  "smoke-disable",
  "smoke-dispatcher",
  "smoke-empty-assistant",
  "smoke-export-mempalace",
  "smoke-graphiti-memory",
  "smoke-install",
  "smoke-kernel-retry",
  "smoke-mempalace",
  "smoke-mempalace-remote",
  "smoke-onecli-setup",
  "smoke-onecli-proxy-env",
  "smoke-outbound-attachment",
  "smoke-persistent-dispatcher",
  "smoke-runtime-scheduling",
  "smoke-skill-bootstrap",
  "smoke-skill-disclosure",
  "smoke-store-reopen",
  "smoke-secret-prompt",
  "smoke-secrets",
  "smoke-suppress-warnings",
  "smoke-terminal-modes",
  "smoke-uninstall",
  "smoke-wildcard",
  "smoke-wizard-defaults",
  "smoke-wizard-shell",
  "smoke-time-awareness",
  "smoke-tool-output-limits",
  "smoke-vision",
  "smoke-whisper",
  "smoke-whisper-profile",
  "smoke-whisper-provision",
];

// Tests that don't need a service manager anymore (host services are retired), but
// still spawn the CLI and may be slower. Run them outside CI by default.
const NEEDS_PROCESS_MANAGER = [
  "smoke-this-turn",
];

// Tests that need a running Docker daemon.
const NEEDS_DOCKER = ["smoke-shared", "smoke-agent-container"];

const scope = process.env.DAE_TEST_SCOPE ?? (process.env.CI ? "ci" : "local");

const tests = [...new Set(CI_SAFE)];

if (scope !== "ci") {
  // local & all — also run the slower CLI-spawning smokes.
  tests.push(...NEEDS_PROCESS_MANAGER);
}
if (scope === "all") {
  tests.push(...NEEDS_DOCKER);
}

console.log(`scope: ${scope} — ${tests.length} test${tests.length === 1 ? "" : "s"}\n`);

let passed = 0;
const failed = [];
for (const t of tests) {
  process.stdout.write(`── ${t.padEnd(32)} `);
  const start = Date.now();
  const r = spawnSync("node", [`scripts/${t}.mjs`], { encoding: "utf8" });
  const dur = `${Math.round((Date.now() - start) / 100) / 10}s`;
  if (r.status === 0 && /result:\s*PASS/m.test(r.stdout)) {
    process.stdout.write(`PASS  (${dur})\n`);
    passed++;
  } else {
    process.stdout.write(`FAIL  (${dur}, exit ${r.status})\n`);
    const tail = (r.stdout + "\n" + r.stderr).split("\n").filter((l) => l.trim()).slice(-8);
    for (const l of tail) console.log(`     │ ${l}`);
    failed.push(t);
  }
}

console.log(`\npassed ${passed}/${tests.length}${failed.length ? `; failed: ${failed.join(", ")}` : ""}`);
process.exit(failed.length ? 1 : 0);
