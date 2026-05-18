// Smoke: dist/cli/suppress-warnings.js filters JUST the SQLite experimental
// warning out of stderr, leaving every other warning intact.

import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

function runNode(script) {
  return spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
}

// 1. Baseline: emitting the warning WITHOUT our module produces the two
// expected stderr lines. Sanity check the suppression target is the same
// string Node actually prints.
{
  const r = spawnSync(
    "node",
    ["-e", "process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning')"],
    { encoding: "utf8" },
  );
  const stderr = r.stderr ?? "";
  expect(
    "baseline: SQLite ExperimentalWarning IS printed without suppress",
    /SQLite is an experimental feature/.test(stderr) && /trace-warnings/.test(stderr),
    `stderr: ${stderr.slice(0, 200)}`,
  );
}

// 2. With our suppress module imported, the same warning is silenced — both
// the header line AND the "Use --trace-warnings" follow-up.
{
  const r = runNode(
    `import "./dist/cli/suppress-warnings.js";
     process.emitWarning('SQLite is an experimental feature and might change at any time', 'ExperimentalWarning');`,
  );
  const stderr = r.stderr ?? "";
  expect(
    "SQLite ExperimentalWarning header is suppressed",
    !/SQLite is an experimental feature/.test(stderr),
    `stderr: ${stderr.slice(0, 200)}`,
  );
  expect(
    "trace-warnings hint line is also suppressed",
    !/Use `node --trace-warnings/.test(stderr),
    `stderr: ${stderr.slice(0, 200)}`,
  );
}

// 3. DeprecationWarning still passes through.
{
  const r = runNode(
    `import "./dist/cli/suppress-warnings.js";
     process.emitWarning('test deprecation', 'DeprecationWarning');`,
  );
  const stderr = r.stderr ?? "";
  expect(
    "DeprecationWarning still passes through",
    /DeprecationWarning: test deprecation/.test(stderr),
    `stderr: ${stderr.slice(0, 200)}`,
  );
}

// 4. A different ExperimentalWarning (NOT the SQLite one) still passes
// through. Verifies we filter by message, not blanket-drop by name.
{
  const r = runNode(
    `import "./dist/cli/suppress-warnings.js";
     process.emitWarning('Some other thing is experimental', 'ExperimentalWarning');`,
  );
  const stderr = r.stderr ?? "";
  expect(
    "unrelated ExperimentalWarning still passes through",
    /Some other thing is experimental/.test(stderr),
    `stderr: ${stderr.slice(0, 200)}`,
  );
}

// 5. Sanity: dae --help exits 0 (suppress module didn't break startup).
{
  const r = spawnSync("node", ["dist/index.js", "--help"], { encoding: "utf8" });
  expect("dae --help exits 0", r.status === 0, `status=${r.status}`);
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
