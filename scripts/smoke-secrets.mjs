// End-to-end smoke for the dae secret CLI.
// Runs `node dist/index.js -c examples/daedalus.config.yaml secret <op>` for each operation
// against the env-file backend, capturing stdout/stderr.
//
// Then it tries the OneCLI backend; expected to fall back / warn since OneCLI isn't running.

import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const args = (...rest) => ["dist/index.js", "-c", "examples/daedalus.config.yaml", "secret", ...rest];

function run(opArgs) {
  const r = spawnSync("node", args(...opArgs), {
    encoding: "utf8",
    env: { ...process.env, NODE_ENV: "test" },
  });
  return { stdout: r.stdout?.trim() ?? "", stderr: r.stderr?.trim() ?? "", code: r.status };
}

const TEST_NAME = "ARTEMIS_TEST_SECRET";
const TEST_VAL = `value-${Date.now()}`;
const envFile = path.resolve("examples/.env.local");

console.log("[1] secret backend");
const r1 = run(["backend"]);
console.log(r1.stdout.split("\n").map((l) => "    " + l).join("\n"));
const ok1 = /^backend: env-file/m.test(r1.stdout);
console.log(`    pass: ${ok1}`);
console.log("");

console.log("[2] secret save (via -v flag, env-file backend)");
const r2 = run(["save", TEST_NAME, "-v", TEST_VAL]);
console.log(`    stdout: ${r2.stdout}`);
console.log(`    stderr: ${r2.stderr}`);
const ok2 = r2.code === 0 && r2.stdout.includes("env-file");
console.log(`    pass: ${ok2}`);
console.log("");

console.log("[3] verify .env.local contains the entry");
let envContent = "";
try {
  envContent = await fs.readFile(envFile, "utf8");
} catch {}
const ok3 = envContent.includes(`${TEST_NAME}=`);
console.log(`    file: ${envFile}`);
console.log(`    contains ${TEST_NAME}=: ${ok3}`);
console.log("");

console.log("[4] secret get");
const r4 = run(["get", TEST_NAME]);
console.log(`    stdout: ${r4.stdout}`);
const ok4 = r4.stdout === TEST_VAL;
console.log(`    pass: ${ok4}`);
console.log("");

console.log("[5] secret list");
const r5 = run(["list"]);
const ok5 = r5.stdout.split("\n").some((l) => l.trim() === TEST_NAME);
console.log(r5.stdout.split("\n").map((l) => "    " + l).join("\n"));
console.log(`    pass: ${ok5}`);
console.log("");

console.log("[6] secret delete");
const r6 = run(["delete", TEST_NAME]);
console.log(`    stdout: ${r6.stdout}`);
const r6Get = run(["get", TEST_NAME]);
const ok6 = r6.code === 0 && r6Get.code !== 0;
console.log(`    pass: ${ok6}`);
console.log("");

const allPass = ok1 && ok2 && ok3 && ok4 && ok5 && ok6;
console.log(`result: ${allPass ? "PASS" : "FAIL"}`);
process.exit(allPass ? 0 : 1);
