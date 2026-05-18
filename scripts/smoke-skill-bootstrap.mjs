// Smoke: skill bootstrap convention.
//
// Builds a fake brain with one skill that ships a bootstrap.sh, runs the
// bootstrap runner against it, asserts:
//   - the script runs (file it drops lands in the shared bin dir)
//   - DAE_SKILL_BIN + DAE_SKILL_PATH_DIR + PATH are exported to the script
//   - the marker file lands and a second run is a no-op
//   - editing the script (content hash change) forces a re-run
//   - bootstrap that exits non-zero is logged but doesn't throw
//   - a skill with no bootstrap.sh is silently skipped

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runSkillBootstraps,
  skillBinRoot,
  sharedBinDir,
} from "../dist/brain/skill-bootstrap.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

function makeSkill(brainRoot, name, scriptBody) {
  const dir = join(brainRoot, "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: test skill\n---\n`);
  if (scriptBody !== null) {
    writeFileSync(join(dir, "bootstrap.sh"), scriptBody);
  }
  return {
    manifest: { name, description: "", requires: { secrets: [] } },
    body: "",
    rootPath: dir,
    readOnly: false,
  };
}

const dataDir = mkdtempSync(join(tmpdir(), "dae-skillboot-data-"));
const brainRoot = mkdtempSync(join(tmpdir(), "dae-skillboot-brain-"));

// 1. Skill with a bootstrap that writes a sentinel file.
{
  const script = `#!/bin/sh
set -e
[ -n "$DAE_SKILL_PATH_DIR" ] || { echo "DAE_SKILL_PATH_DIR not set" >&2; exit 1; }
[ -n "$DAE_SKILL_BIN" ] || { echo "DAE_SKILL_BIN not set" >&2; exit 1; }
echo "hello from alpha" > "$DAE_SKILL_PATH_DIR/alpha-installed"
`;
  const skill = makeSkill(brainRoot, "alpha", script);
  const results = await runSkillBootstraps([skill], dataDir);
  const r = results.get("alpha");
  expect("alpha ran once", r?.ran === true && r?.alreadyDone === false);
  expect("alpha exited 0", r?.exitCode === 0);
  expect(
    "alpha dropped its sentinel file into the shared bin dir",
    existsSync(join(sharedBinDir(dataDir), "alpha-installed")),
  );
}

// 2. Running again is a no-op — marker hit.
{
  const skill = makeSkill(brainRoot, "alpha", null); // bootstrap.sh already on disk
  // Re-read the previously-written script body for a fair test
  skill.rootPath = join(brainRoot, "skills", "alpha");
  const results = await runSkillBootstraps([skill], dataDir);
  const r = results.get("alpha");
  expect("second alpha run is a no-op (marker hit)", r?.ran === false && r?.alreadyDone === true);
}

// 3. Edit the script → re-runs (content hash changed).
{
  writeFileSync(
    join(brainRoot, "skills", "alpha", "bootstrap.sh"),
    `#!/bin/sh
echo "v2" > "$DAE_SKILL_PATH_DIR/alpha-installed-v2"
`,
  );
  const skill = {
    manifest: { name: "alpha", description: "", requires: { secrets: [] } },
    body: "",
    rootPath: join(brainRoot, "skills", "alpha"),
    readOnly: false,
  };
  const results = await runSkillBootstraps([skill], dataDir);
  const r = results.get("alpha");
  expect(
    "edited script forces a re-run",
    r?.ran === true && r?.alreadyDone === false && r?.exitCode === 0,
  );
  expect(
    "v2 sentinel landed",
    existsSync(join(sharedBinDir(dataDir), "alpha-installed-v2")),
  );
}

// 4. Failing bootstrap is logged but doesn't throw.
{
  const skill = makeSkill(
    brainRoot,
    "beta",
    `#!/bin/sh\necho "boom" >&2\nexit 7\n`,
  );
  const results = await runSkillBootstraps([skill], dataDir);
  const r = results.get("beta");
  expect("failing bootstrap returns non-zero exit code", r?.exitCode === 7);
  expect("failing bootstrap captured stderr tail", /boom/.test(r?.stderrTail ?? ""));
  // No marker should exist for beta.
  expect(
    "no marker file for failing bootstrap (will retry next turn)",
    Array.from(
      (() => {
        try {
          // read .bootstrap dir contents
          const fs = require("node:fs");
          return fs.readdirSync(join(skillBinRoot(dataDir), ".bootstrap"));
        } catch {
          return [];
        }
      })(),
    ).every((f) => !f.startsWith("beta-")),
  );
}

// 5. Skill without bootstrap.sh is silently skipped.
{
  const skill = makeSkill(brainRoot, "gamma", null);
  const results = await runSkillBootstraps([skill], dataDir);
  expect("skill without bootstrap.sh produces no result entry", !results.has("gamma"));
}

// 6. PATH was prepended so the script sees its own dir on PATH.
{
  // Drop a fake binary in the shared bin dir then have a fresh skill check
  // that PATH lookup finds it.
  writeFileSync(
    join(sharedBinDir(dataDir), "marker-bin"),
    `#!/bin/sh\necho marker-found\n`,
  );
  const fs = await import("node:fs");
  fs.chmodSync(join(sharedBinDir(dataDir), "marker-bin"), 0o755);
  const skill = makeSkill(
    brainRoot,
    "delta",
    `#!/bin/sh\ncommand -v marker-bin >/dev/null && marker-bin > "$DAE_SKILL_PATH_DIR/delta.out"\n`,
  );
  const results = await runSkillBootstraps([skill], dataDir);
  expect(
    "shared bin dir is on PATH during bootstrap",
    results.get("delta")?.exitCode === 0 &&
      existsSync(join(sharedBinDir(dataDir), "delta.out")) &&
      readFileSync(join(sharedBinDir(dataDir), "delta.out"), "utf8").includes("marker-found"),
  );
}

rmSync(dataDir, { recursive: true, force: true });
rmSync(brainRoot, { recursive: true, force: true });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
