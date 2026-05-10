// Smoke for `dae setup/disable whisper`.
// Drives via the CLI for list/disable. Setup is interactive; we exercise the disable
// round-trip on a synthetic config that already has whisper enabled.

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. setup --list / disable --list both mention whisper
const setupList = spawnSync("node", ["dist/index.js", "setup", "--list"], { encoding: "utf8" });
expect("setup --list mentions whisper", /whisper\s+Whisper/.test(setupList.stdout), "row not found");
const disableList = spawnSync("node", ["dist/index.js", "disable", "--list"], { encoding: "utf8" });
expect("disable --list mentions whisper", /whisper/.test(disableList.stdout));

// 2. End-to-end disable on a synthetic config in remote mode (openai)
const tmp = path.join(os.tmpdir(), `dae-whisper-smoke-${Date.now()}`);
await fs.mkdir(tmp, { recursive: true });
const cfgPath = path.join(tmp, "daedalus.config.yaml");
const envPath = path.join(tmp, ".env.local");

await fs.writeFile(
  cfgPath,
  `
brain:
  path: ${path.resolve("examples/brain").replaceAll("\\", "/")}

transcribe:
  backend: openai-whisper
  apiKey: \${WHISPER_OPENAI_API_KEY}
  baseUrl: https://api.openai.com/v1
  model: whisper-1
`.trim() + "\n",
  "utf8",
);
await fs.writeFile(envPath, "WHISPER_OPENAI_API_KEY=fake-key-for-smoke\n", "utf8");

// 3. Default disable: keep block + key, just flip backend to none
const r1 = spawnSync("node", ["dist/index.js", "-c", cfgPath, "disable", "whisper"], { encoding: "utf8" });
expect("disable whisper exit 0", r1.status === 0, r1.stderr.split("\n").slice(-3).join(" / "));
const cfg1 = await fs.readFile(cfgPath, "utf8");
expect("yaml: transcribe.backend → 'none'", /backend:\s*none/.test(cfg1));
expect("yaml: baseUrl preserved on default disable", /baseUrl:\s*https:\/\/api\.openai\.com\/v1/.test(cfg1));
const env1 = await fs.readFile(envPath, "utf8");
expect("env: WHISPER_OPENAI_API_KEY preserved on default disable", /WHISPER_OPENAI_API_KEY=/.test(env1));

// 4. Idempotent
const r2 = spawnSync("node", ["dist/index.js", "-c", cfgPath, "disable", "whisper"], { encoding: "utf8" });
expect("disable whisper idempotent (exit 0)", r2.status === 0);

// 5. Purge: nukes block + key
const r3 = spawnSync(
  "node",
  ["dist/index.js", "-c", cfgPath, "disable", "whisper", "--purge", "--yes"],
  { encoding: "utf8" },
);
expect("disable whisper --purge exit 0", r3.status === 0, r3.stderr.split("\n").slice(-3).join(" / "));
const cfg2 = await fs.readFile(cfgPath, "utf8");
expect("yaml: transcribe block removed by purge", !/^transcribe:/m.test(cfg2));
const env2 = await fs.readFile(envPath, "utf8");
expect("env: WHISPER_OPENAI_API_KEY removed by purge", !/^WHISPER_OPENAI_API_KEY=/m.test(env2));

// 6. The OpenAITranscriber URL convention — baseUrl must include /v1, not get doubled
const transcribeMod = await import("../dist/attachments/transcribe.js");
const t = new transcribeMod.OpenAITranscriber({
  apiKey: "test",
  baseUrl: "http://localhost:8000/v1",
  model: "whisper-1",
});
// Stub fetch to capture the URL it tries
const origFetch = globalThis.fetch;
let capturedUrl = "";
globalThis.fetch = async (url) => {
  capturedUrl = String(url);
  return { ok: false, status: 500, json: async () => ({}) };
};
await t.transcribe(Buffer.from("x"), "audio/wav");
globalThis.fetch = origFetch;
expect(
  "transcriber URL: baseUrl with /v1 doesn't get doubled",
  capturedUrl === "http://localhost:8000/v1/audio/transcriptions",
  capturedUrl,
);

await fs.rm(tmp, { recursive: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
