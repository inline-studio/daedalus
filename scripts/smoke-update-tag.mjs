// SEC-13: `dae update` must only accept a strict version tag from the GitHub API before using
// it to build the artifact download URL / install command — a malformed or hostile tag must
// be refused, not interpolated into a path or shell-adjacent string.

import { isValidReleaseTag } from "../dist/cli/update.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// Valid version tags (the project's shape + plain semver).
for (const t of ["v0.1.0-134", "v0.1.0", "0.1.0", "1.2.3", "v10.20.30-5"]) {
  expect(`accepts '${t}'`, isValidReleaseTag(t));
}

// Invalid / hostile tags must be rejected.
for (const t of [
  "latest",
  "1.0",
  "v1.0.0.0",
  "",
  "v1.0.0; rm -rf /",
  "v1.0.0 && curl evil",
  "../../../etc/passwd",
  "v1.0.0/../../evil",
  "$(whoami)",
  "v1.0.0-abc",
  "v1.0.0-",
]) {
  expect(`rejects ${JSON.stringify(t)}`, !isValidReleaseTag(t));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
