// Smoke for the `glob` built-in tool.
//
// Why this exists: cypher's manifest declares `tools: [glob, ...]` but glob wasn't
// in the registry — every dispatch crashed with "Unknown built-in tool: glob". The
// tool is a thin wrapper around Node 24's `fs.promises.glob`. This smoke covers:
//   1. It's in the registry (selectBuiltins can build it via name and wildcard).
//   2. Pattern matching works (single segment, `**`, alternation).
//   3. cwd is respected; results are relative to it.
//   4. Empty match returns a clear "[no matches…]" marker, not an error.
//   5. The match-count cap kicks in with the "narrow the pattern" hint.
//   6. Missing pattern is a clean error, not a thrown exception.
//   7. Results are sorted (so the model gets a stable ordering across runs).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globTool } from "../dist/tools/file.js";
import { selectBuiltins, builtinNames } from "../dist/tools/registry.js";
import { GLOB_DEFAULT_LIMIT, GLOB_MAX_LIMIT } from "../dist/tools/limits.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// ---------- scratch tree -----------------------------------------------------
const root = fs.mkdtempSync(path.join(os.tmpdir(), "dae-glob-"));
const w = (rel, body = "") => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
w("a.ts");
w("b.ts");
w("c.js");
w("nested/d.ts");
w("nested/e.md");
w("nested/deep/f.ts");
w("nested/deep/g.txt");

// ---------- 1. registry ------------------------------------------------------
{
  const names = builtinNames();
  expect("registry lists 'glob'", names.includes("glob"));

  const fakeConfig = { web: {} };
  const direct = selectBuiltins(["glob"], fakeConfig);
  expect("selectBuiltins(['glob']) returns the tool", direct.length === 1 && direct[0].definition.name === "glob");

  const wild = selectBuiltins(["*"], fakeConfig);
  expect("wildcard includes glob", wild.some((t) => t.definition.name === "glob"));
}

// ---------- 2. patterns ------------------------------------------------------
{
  // shallow *
  const r = await globTool.invoke({ pattern: "*.ts", cwd: root }, {});
  const lines = r.content.split("\n");
  expect("'*.ts' matches only top-level a.ts + b.ts", lines.length === 2 && lines.includes("a.ts") && lines.includes("b.ts"));
  expect("'*.ts' excludes nested matches", !lines.some((l) => l.includes("/")));

  // ** recursive
  const r2 = await globTool.invoke({ pattern: "**/*.ts", cwd: root }, {});
  const all = r2.content.split("\n");
  expect("'**/*.ts' finds nested .ts files", all.includes("nested/d.ts") && all.includes("nested/deep/f.ts"));
  expect("'**/*.ts' excludes non-ts files", !all.some((l) => l.endsWith(".md") || l.endsWith(".txt")));

  // alternation
  const r3 = await globTool.invoke({ pattern: "nested/**/*.{md,txt}", cwd: root }, {});
  const alt = r3.content.split("\n");
  expect("alternation works ({md,txt})", alt.includes("nested/e.md") && alt.includes("nested/deep/g.txt") && alt.length === 2);
}

// ---------- 3. cwd default ---------------------------------------------------
{
  const orig = process.cwd();
  process.chdir(root);
  try {
    const r = await globTool.invoke({ pattern: "*.js" }, {});
    expect("defaults cwd to process.cwd()", r.content === "c.js");
  } finally {
    process.chdir(orig);
  }
}

// ---------- 4. no matches ----------------------------------------------------
{
  const r = await globTool.invoke({ pattern: "*.does-not-exist", cwd: root }, {});
  expect("zero matches returns a friendly marker, not an error", !r.isError && r.content.startsWith("[no matches"));
}

// ---------- 5. cap -----------------------------------------------------------
{
  // 1200 files in a flat dir — exceeds default 1000.
  const capRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dae-glob-cap-"));
  for (let i = 0; i < 1200; i++) fs.writeFileSync(path.join(capRoot, `f${i}.x`), "");
  const r = await globTool.invoke({ pattern: "*.x", cwd: capRoot }, {});
  expect("default cap is GLOB_DEFAULT_LIMIT", GLOB_DEFAULT_LIMIT === 1000);
  const lines = r.content.split("\n");
  // lines = 1000 matches + 1 footer line
  expect("hitting the cap appends a 'narrow the pattern' hint", lines.length === 1001 && lines[1000].includes("narrow the pattern"));
  expect("explicit limit overrides default", (await globTool.invoke({ pattern: "*.x", cwd: capRoot, limit: 5 }, {})).content.split("\n").length === 6);
  expect("limit is ceilinged at GLOB_MAX_LIMIT", GLOB_MAX_LIMIT === 5000);
  fs.rmSync(capRoot, { recursive: true, force: true });
}

// ---------- 6. validation ----------------------------------------------------
{
  const missing = await globTool.invoke({}, {});
  expect("missing pattern is a clean error", missing.isError && missing.content.includes("required"));

  const empty = await globTool.invoke({ pattern: "   " }, {});
  expect("whitespace-only pattern is a clean error", empty.isError && empty.content.includes("required"));
}

// ---------- 7. sorted --------------------------------------------------------
{
  const r = await globTool.invoke({ pattern: "**/*.ts", cwd: root }, {});
  const lines = r.content.split("\n");
  const sorted = [...lines].sort();
  expect("matches come back sorted (stable ordering across runs)", lines.every((l, i) => l === sorted[i]));
}

// ---------- teardown ---------------------------------------------------------
fs.rmSync(root, { recursive: true, force: true });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
