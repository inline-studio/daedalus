// Round-trip smoke for disable / --purge symmetry.
//
//   1. Build a fresh config + .env.local in a tmp dir
//   2. Programmatically simulate "search enabled" via direct YAML edit (skips prompts)
//   3. `dae disable search` flips it off, leaves config keys + secret intact
//   4. Re-run is a no-op (idempotent)
//   5. `dae disable search --purge --yes` clears the config block and the secret
//
// Same for telegram & onecli (toggles only — these have richer setup paths).

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmpDir = path.join(os.tmpdir(), `dae-disable-smoke-${Date.now()}`);
await fs.mkdir(tmpDir, { recursive: true });
const configPath = path.join(tmpDir, "daedalus.config.yaml");
const envPath = path.join(tmpDir, ".env.local");

// Minimal config that still loads (brain.path is required).
const baseConfig = `
# Test config for disable smoke
brain:
  path: ${path.resolve("examples/brain").replaceAll("\\", "/")}

web:
  search:
    provider: brave
    apiKey: \${BRAVE_API_KEY}
  fetch:
    maxBytes: 1000000

channels:
  telegram:
    enabled: true
    defaultAgent: orchestrator
    token: \${TELEGRAM_BOT_TOKEN}

onecli:
  enabled: true
  proxy: http://localhost:10255
secrets:
  backend: onecli
  onecli:
    baseUrl: http://localhost:10254
`;
await fs.writeFile(configPath, baseConfig.trim() + "\n", "utf8");
await fs.writeFile(
  envPath,
  ["BRAVE_API_KEY=fake-brave-key-12345", "TELEGRAM_BOT_TOKEN=99999:fake-telegram-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"].join("\n") + "\n",
  "utf8",
);

const run = (...args) =>
  spawnSync("node", ["dist/index.js", "-c", configPath, ...args], {
    encoding: "utf8",
    env: process.env,
  });

// 1. disable --list shows everything
const list = run("disable", "--list");
expect("disable --list shows search", /search/.test(list.stdout));
expect("disable --list shows telegram", /telegram/.test(list.stdout));
expect("disable --list shows onecli", /onecli/.test(list.stdout));

// 2. disable search (default — keep secrets, just flip provider to none)
const r1 = run("disable", "search");
expect("disable search exit 0", r1.status === 0, r1.stderr.split("\n").slice(-3).join(" / "));
const cfg1 = await fs.readFile(configPath, "utf8");
expect("config: web.search.provider is now 'none'", /provider:\s*none/.test(cfg1));
expect("config: BRAVE_API_KEY reference still present", /\$\{BRAVE_API_KEY\}/.test(cfg1));
const env1 = await fs.readFile(envPath, "utf8");
expect("env: BRAVE_API_KEY still present (default disable doesn't purge)", /BRAVE_API_KEY=/.test(env1));

// 3. Idempotent — second disable is fine
const r2 = run("disable", "search");
expect("disable search idempotent (exit 0)", r2.status === 0);

// 4. disable telegram (default)
const r3 = run("disable", "telegram");
expect("disable telegram exit 0", r3.status === 0);
const cfg2 = await fs.readFile(configPath, "utf8");
expect("config: telegram.enabled is now false", /telegram:[\s\S]*?enabled:\s*false/m.test(cfg2));

// 5. disable onecli (default — flip back to env-file)
const r4 = run("disable", "onecli");
expect("disable onecli exit 0", r4.status === 0);
const cfg3 = await fs.readFile(configPath, "utf8");
expect("config: onecli.enabled is now false", /onecli:[\s\S]*?enabled:\s*false/m.test(cfg3));
expect("config: secrets.backend reverted to env-file", /backend:\s*env-file/.test(cfg3));

// 6. --purge --yes on search: nukes the block AND the secret
const r5 = run("disable", "search", "--purge", "--yes");
expect("disable search --purge exit 0", r5.status === 0, r5.stderr.split("\n").slice(-3).join(" / "));
const cfg4 = await fs.readFile(configPath, "utf8");
expect("config: web.search block removed", !/^web:[\s\S]*?search:/m.test(cfg4));
const env2 = await fs.readFile(envPath, "utf8");
expect("env: BRAVE_API_KEY removed by purge", !/^BRAVE_API_KEY=/m.test(env2));

// 7. --purge --yes on telegram
const r6 = run("disable", "telegram", "--purge", "--yes");
expect("disable telegram --purge exit 0", r6.status === 0);
const cfg5 = await fs.readFile(configPath, "utf8");
expect("config: telegram block removed", !/telegram:/.test(cfg5));
const env3 = await fs.readFile(envPath, "utf8");
expect("env: TELEGRAM_BOT_TOKEN removed by purge", !/^TELEGRAM_BOT_TOKEN=/m.test(env3));

// 8. unknown thing → clear error
const r7 = run("disable", "nonexistent-thing");
expect("disable nonexistent thing fails cleanly", r7.status !== 0 && /Unknown/.test(r7.stderr));

await fs.rm(tmpDir, { recursive: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
