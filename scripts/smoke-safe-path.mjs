// SEC-16: brain file resolution must not escape the brain directory. assertUnderBrain allows
// paths under the brain root (and the root itself) and throws on traversal / absolute escapes,
// including a sibling directory that merely shares the root as a string prefix.

import { assertUnderBrain } from "../dist/brain/safe-path.js";
import path from "node:path";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const brain = "/srv/brain";
const allowed = (t) => {
  try {
    assertUnderBrain(brain, t);
    return true;
  } catch {
    return false;
  }
};

expect("normal agent path allowed", allowed(path.join(brain, "agents", "artemis.md")));
expect("nested skill path allowed", allowed(path.join(brain, "skills", "foo", "SKILL.md")));
expect("brain root itself allowed", allowed(brain));

expect("../ traversal blocked", !allowed(path.join(brain, "agents", "..", "..", "etc", "passwd")));
expect("absolute escape blocked", !allowed("/etc/passwd"));
expect("sibling sharing the prefix (brain2) blocked", !allowed("/srv/brain2/x"));

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
