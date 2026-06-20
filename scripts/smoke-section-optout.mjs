// Smoke for the composer's section selection: empty/omitted = include ALL files in a brain dir,
// a named subset = only those, and ["none"] = include NOTHING (the explicit opt-out so an
// orchestrator can drop e.g. the coding standards from its prompt).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { composeSystemPrompt } from "../dist/brain/composer.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dae-optout-"));
fs.mkdirSync(path.join(tmp, "standards"), { recursive: true });
fs.mkdirSync(path.join(tmp, "operations"), { recursive: true });
fs.writeFileSync(path.join(tmp, "standards", "coding.md"), "CODING_STD_MARKER");
fs.writeFileSync(path.join(tmp, "standards", "rigor.md"), "RIGOR_STD_MARKER");
fs.writeFileSync(path.join(tmp, "operations", "ops.md"), "OPS_MARKER");

const compose = (over) =>
  composeSystemPrompt({
    brainPath: tmp,
    agent: { name: "t", standards: [], operations: [], souls: [], personas: [], timeAware: false, ...over },
    agentBody: "",
    skills: [],
  });

// 1. Empty = include all standards.
{
  const p = await compose({});
  expect("empty standards → all included", p.includes("CODING_STD_MARKER") && p.includes("RIGOR_STD_MARKER"));
}

// 2. Named subset = only those.
{
  const p = await compose({ standards: ["rigor"] });
  expect("subset → only named", p.includes("RIGOR_STD_MARKER") && !p.includes("CODING_STD_MARKER"));
}

// 3. ["none"] = drop the whole section.
{
  const p = await compose({ standards: ["none"] });
  expect("[none] → no Standards section", !/# Standards/.test(p) && !p.includes("CODING_STD_MARKER"));
}

// 4. ["none"] works for operations too (and is case-insensitive).
{
  const p = await compose({ operations: ["NONE"] });
  expect("[NONE] → no Operations section (case-insensitive)", !/# Operations/.test(p) && !p.includes("OPS_MARKER"));
}

// 5. Dropping standards doesn't affect operations.
{
  const p = await compose({ standards: ["none"] });
  expect("dropping standards keeps operations", p.includes("OPS_MARKER"));
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
