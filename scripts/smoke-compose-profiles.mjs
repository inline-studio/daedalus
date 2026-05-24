// Smoke for COMPOSE_PROFILES computation: profiles must be MERGED into the single
// comma-joined value compose expects — never overwritten (which would silently drop
// whichever service isn't named, e.g. setting "graphiti" alone would stop whisper).

import { computeComposeProfiles, profileArgsFrom } from "../dist/install.js";

let pass = true;
const eq = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — got ${g}, want ${w}`}`);
  if (!ok) pass = false;
};

// computeComposeProfiles merges enabled services.
eq("none → empty", computeComposeProfiles({ whisper: false, graphiti: false }), "");
eq("whisper only", computeComposeProfiles({ whisper: true, graphiti: false }), "whisper");
eq("graphiti only", computeComposeProfiles({ whisper: false, graphiti: true }), "graphiti");
eq("both → merged", computeComposeProfiles({ whisper: true, graphiti: true }), "graphiti,whisper");

// profileArgsFrom turns the merged value into repeated --profile args.
eq("args: empty", profileArgsFrom(""), []);
eq("args: one", profileArgsFrom("whisper"), ["--profile", "whisper"]);
eq("args: merged", profileArgsFrom("graphiti,whisper"), [
  "--profile",
  "graphiti",
  "--profile",
  "whisper",
]);
eq("args: tolerate spaces/blanks", profileArgsFrom(" graphiti , , whisper "), [
  "--profile",
  "graphiti",
  "--profile",
  "whisper",
]);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
