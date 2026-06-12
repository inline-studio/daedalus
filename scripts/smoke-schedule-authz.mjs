// SEC-06: schedule_message target authorization. An agent may schedule a turn only for
// itself or for an agent it could spawn (its subagents; '*' = every agent). This mirrors
// the spawn_subagent trust edge, so scheduling grants no more reach than spawning.
// Exercises scheduleTargetAllowed against the hierarchy: artemis -> cypher -> cypher-php8.5.

import { scheduleTargetAllowed } from "../dist/tools/schedule.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// Hierarchy under test:
//   artemis.subagents      = ['*']                              (top orchestrator)
//   cypher.subagents       = ['cypher-php8.5','cypher-php8.4','triage']
//   cypher-php8.5.subagents= []                                 (leaf)
const ALL = ["artemis", "cypher", "cypher-php8.5", "cypher-php8.4", "triage"];
const cypherSubs = ["cypher-php8.5", "cypher-php8.4", "triage"];
const allow = (caller, target, subs, all = ALL) => scheduleTargetAllowed(caller, target, subs, all);

// --- artemis (subagents: ['*']) can target any agent except via self-rule, incl. cypher ---
expect("artemis -> cypher (declared via *)", allow("artemis", "cypher", ["*"]));
expect("artemis -> cypher-php8.5 (via *)", allow("artemis", "cypher-php8.5", ["*"]));
expect("artemis -> artemis (self)", allow("artemis", "artemis", ["*"]));

// --- cypher can schedule itself + its declared subagents, but not up or sideways ---
expect("cypher -> cypher-php8.5", allow("cypher", "cypher-php8.5", cypherSubs));
expect("cypher -> cypher-php8.4", allow("cypher", "cypher-php8.4", cypherSubs));
expect("cypher -> triage", allow("cypher", "triage", cypherSubs));
expect("cypher -> cypher (self)", allow("cypher", "cypher", cypherSubs));
expect("cypher -> artemis FAILS (cannot schedule higher)", !allow("cypher", "artemis", cypherSubs));

// --- cypher-php8.5 is a leaf: only itself ---
expect("cypher-php8.5 -> cypher-php8.5 (self)", allow("cypher-php8.5", "cypher-php8.5", []));
expect("cypher-php8.5 -> triage FAILS (sibling)", !allow("cypher-php8.5", "triage", []));
expect("cypher-php8.5 -> artemis FAILS", !allow("cypher-php8.5", "artemis", []));
expect("cypher-php8.5 -> cypher FAILS (parent)", !allow("cypher-php8.5", "cypher", []));

// --- '*' caveat: a mid-tier agent with '*' CAN reach up (documented; keep '*' top-only) ---
expect(
  "mid-tier with '*' can reach artemis (documented caveat)",
  allow("cypher", "artemis", ["*"]),
);

// --- self is always allowed even with no spawn rights ---
expect("leaf -> self always allowed", allow("loner", "loner", []));
// --- unknown target not in subagents is rejected (also blocks typos) ---
expect("cypher -> nonexistent FAILS", !allow("cypher", "ghost", cypherSubs));

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
