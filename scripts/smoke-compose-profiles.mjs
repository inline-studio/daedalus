// Smoke for COMPOSE_PROFILES computation: profiles must be MERGED into the single
// comma-joined value compose expects — never overwritten (which would silently drop
// whichever service isn't named, e.g. setting "graphiti" alone would stop whisper).
// The merged value is persisted to the compose .env; compose reads it automatically,
// so no `--profile` flag is needed at bring-up.

import { computeComposeProfiles } from "../dist/install.js";

let pass = true;
const eq = (label, got, want) => {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  const ok = g === w;
  console.log(`${ok ? "✓" : "✗"} ${label}${ok ? "" : ` — got ${g}, want ${w}`}`);
  if (!ok) pass = false;
};

// computeComposeProfiles merges enabled services into one comma-joined list.
eq("none → empty", computeComposeProfiles({ whisper: false, graphiti: false }), "");
eq("whisper only", computeComposeProfiles({ whisper: true, graphiti: false }), "whisper");
eq("graphiti only", computeComposeProfiles({ whisper: false, graphiti: true }), "graphiti");
eq("both → merged", computeComposeProfiles({ whisper: true, graphiti: true }), "graphiti,whisper");

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
