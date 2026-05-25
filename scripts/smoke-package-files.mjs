// Guard the npm packaging invariant: every compose/build file `dae install` materialises
// (COMPOSE_FILES) MUST be (a) present in the repo and (b) whitelisted in package.json `files`,
// so it actually ships in the published tarball. The casa graphiti build failure
// ("open Dockerfile.graphiti: no such file or directory") was exactly this gap — the compose
// file referenced a build context whose Dockerfile.graphiti was never packaged.

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { COMPOSE_FILES } from "../dist/install.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8"));
const shipped = new Set(pkg.files ?? []);

let pass = true;
const ok = (label, cond) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) pass = false;
};

for (const f of COMPOSE_FILES) {
  ok(`${f} exists in the repo`, existsSync(path.join(repoRoot, f)));
  ok(`${f} is in package.json "files"`, shipped.has(f));
}

// No stale whitelist entries pointing at files that no longer exist (e.g. retired
// Dockerfile.mempalace) — those just confuse `npm pack` and the next maintainer.
for (const f of shipped) {
  if (f.endsWith("/")) continue; // directory entry (dist/, examples/)
  ok(`whitelisted "${f}" still exists`, existsSync(path.join(repoRoot, f)));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
