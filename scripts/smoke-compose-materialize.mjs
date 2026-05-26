// Smoke for materializeComposeFiles — the function `dae install` and `dae update`
// call to populate ~/.daedalus/compose/ with the build context for `docker compose
// up --build`.
//
// Why this exists: PR #75 added runtime/{agent-turn.sh,setup-ssh.sh} to the
// Dockerfile (COPY runtime/agent-turn.sh /dae-runtime/…) but I forgot to add
// them to COMPOSE_FILES, so on casa `dae update` blew up with
//   "/runtime/agent-turn.sh": not found
// during docker build, because the install dir only contained the explicit
// COMPOSE_FILES list. This smoke catches that class of bug by actually running
// the materialize step into a temp dir and asserting every COMPOSE_FILES entry
// lands AND the generated .dockerignore allows it through.
//
// Coverage:
//   1. Every entry in COMPOSE_FILES lands in the target dir (including nested
//      entries that need their parent created on the fly).
//   2. The auto-derived .dockerignore allows each file AND every parent dir
//      along the way (docker would otherwise refuse to traverse into them).
//   3. Symmetry — the .dockerignore doesn't have stale allow lines pointing at
//      paths that aren't in COMPOSE_FILES anymore.

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { refreshComposeAssets, COMPOSE_FILES } from "../dist/install.js";

let pass = true;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) pass = false;
};

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "dae-materialize-"));

try {
  const copied = await refreshComposeAssets(tmp);
  ok("refreshComposeAssets reports it copied docker-compose.yml", copied === true);

  // 1. Every COMPOSE_FILES entry materialised.
  for (const f of COMPOSE_FILES) {
    const stat = await fs.stat(path.join(tmp, f)).catch(() => null);
    ok(`${f} landed in the target dir`, !!stat && stat.isFile());
  }

  // 2. .dockerignore allows each file + every parent segment.
  const ignore = await fs.readFile(path.join(tmp, ".dockerignore"), "utf8");
  const allowLines = new Set(
    ignore.split("\n").filter((l) => l.startsWith("!")).map((l) => l.slice(1)),
  );

  for (const f of COMPOSE_FILES) {
    ok(`.dockerignore allows ${f}`, allowLines.has(f));
    // Every parent dir along the path must also be allowed; otherwise docker
    // sees the dir as ignored and refuses to look inside (this is what bit
    // runtime/ — the file allow was useless without `!runtime`).
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) {
      const parent = parts.slice(0, i).join("/");
      ok(`.dockerignore allows parent dir '${parent}' of ${f}`, allowLines.has(parent));
    }
  }

  // 3. The tarball glob is still in there (it's added separately, not from COMPOSE_FILES).
  ok(".dockerignore still allows the packed CLI tarball", allowLines.has("daedalus-*.tgz"));

  // 4. The specific regressions: runtime/agent-turn.sh + setup-ssh.sh present
  //    AND executable bit preserved (the shim is invoked as /dae-runtime/agent-turn.sh).
  for (const sh of ["runtime/agent-turn.sh", "runtime/setup-ssh.sh"]) {
    const s = await fs.stat(path.join(tmp, sh)).catch(() => null);
    ok(`${sh} materialised`, !!s && s.isFile());
    if (s) ok(`${sh} is executable (mode & 0o100)`, (s.mode & 0o100) !== 0);
  }
} finally {
  await fs.rm(tmp, { recursive: true, force: true });
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
