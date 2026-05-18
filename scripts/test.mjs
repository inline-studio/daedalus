// Daedalus test runner — runs the smoke battery in sequence and reports.
// Used by `npm test` and the CI workflow.
//
// We split the smokes into three buckets:
//   1. CI-safe       — pure unit/wiring; no Docker daemon, no systemd, no live LLM
//   2. Needs Docker  — the runtime + agent-in-container tests
//   3. Needs systemd — service-install end-to-end tests (renderers themselves are CI-safe)
//
// The default `npm test` runs CI-safe + (optionally) Docker if available + (optionally)
// systemd if available. Set DAE_TEST_SCOPE to control:
//   ci      → CI-safe only (default in CI; set by the workflow)
//   local   → CI-safe + Docker + systemd if detected (default outside CI)
//   all     → run everything; failures from missing-prerequisite tests are surfaced

import { spawnSync } from "node:child_process";

const CI_SAFE = [
  "smoke-disable",
  "smoke-dispatcher",
  "smoke-export-mempalace",
  "smoke-mempalace",
  "smoke-mempalace-localhttp",
  "smoke-mempalace-remote",
  "smoke-linger",
  "smoke-onecli-setup",
  "smoke-runtime-scheduling",
  "smoke-secret-prompt",
  "smoke-secrets",
  "smoke-suppress-warnings",
  "smoke-terminal-modes",
  "smoke-wizard-shell",
  "smoke-service",        // directly drives renderers; no live systemctl call
  "smoke-time-awareness",
  "smoke-whisper",
  "smoke-export-mempalace",
];

// Tests that go through buildServiceManager → systemctl/launchctl. On Linux without
// systemd-user available, they bail with the friendly "use WSL" path; on Windows they
// always do. Run them only when systemd-user is detected, OR on macOS, OR on Windows.
const NEEDS_PROCESS_MANAGER = [
  "smoke-this-turn",
  "smoke-wizard-defaults",
  "smoke-install",
];

// Tests that need a running Docker daemon.
const NEEDS_DOCKER = ["smoke-shared", "smoke-agent-container"];

const scope = process.env.DAE_TEST_SCOPE ?? (process.env.CI ? "ci" : "local");

const tests = [...new Set(CI_SAFE)];

if (scope !== "ci") {
  // local & all — try the process-manager tests too. They self-degrade on Windows / no-systemd.
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
