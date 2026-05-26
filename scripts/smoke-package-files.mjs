// Guard the npm packaging invariant: every compose/build file `dae install` materialises
// (COMPOSE_FILES) MUST be (a) present in the repo and (b) shipped by package.json `files`
// — either listed explicitly OR under a directory entry (e.g. "runtime/" covers
// "runtime/agent-turn.sh"). Two casa failures came from breaking this invariant:
//   * Dockerfile.graphiti was added to COMPOSE_FILES but not to package.json files.
//   * runtime/{agent-turn.sh,setup-ssh.sh} were added with only "runtime/" in files;
//     this smoke previously did a flat .has() check and missed the prefix case.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { COMPOSE_FILES } from "../dist/install.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const shipped = pkg.files ?? [];

let pass = true;
const ok = (label, cond) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) pass = false;
};

// True if `file` is covered by the `files` list — either an exact match, or
// it sits under a directory entry (`runtime/` covers `runtime/agent-turn.sh`).
// npm `files` directory entries don't strictly need the trailing slash, but
// daedalus uses it consistently — we accept both.
function isShipped(file) {
  for (const entry of shipped) {
    if (entry === file) return true;
    const dirPrefix = entry.endsWith("/") ? entry : entry + "/";
    if (file.startsWith(dirPrefix)) return true;
  }
  return false;
}

for (const f of COMPOSE_FILES) {
  ok(`${f} exists in the repo`, existsSync(path.join(repoRoot, f)));
  ok(`${f} is shipped by package.json "files"`, isShipped(f));
}

// No stale whitelist entries pointing at files that no longer exist (e.g. retired
// Dockerfile.mempalace) — those just confuse `npm pack` and the next maintainer.
for (const f of shipped) {
  if (f.endsWith("/")) continue; // directory entry (dist/, examples/, runtime/)
  ok(`whitelisted "${f}" still exists`, existsSync(path.join(repoRoot, f)));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
