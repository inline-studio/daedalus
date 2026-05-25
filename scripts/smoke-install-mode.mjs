// Smoke for installAnswerMode — the three-way decision behind `dae install`/`dae update`:
//   apply (update supplied answers) · reuse (re-run, no --fresh) · interactive (fresh / first run).
// Regression guard: a plain `dae install` on an already-set-up host must REUSE, not re-ask.

import { installAnswerMode } from "../dist/install.js";

let pass = true;
const ok = (label, cond) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) pass = false;
};

// `dae update` always supplies answers → apply, regardless of fresh/priorInstall.
ok("hasAnswers → apply", installAnswerMode({ hasAnswers: true, fresh: false, priorInstall: true }) === "apply");
ok("hasAnswers wins over fresh", installAnswerMode({ hasAnswers: true, fresh: true, priorInstall: false }) === "apply");

// The bug we fixed: `dae install` (no --fresh) on an existing install must REUSE, not ask.
ok("re-run, no --fresh → reuse", installAnswerMode({ hasAnswers: false, fresh: false, priorInstall: true }) === "reuse");

// `dae install --fresh` always asks, even with a prior install.
ok("--fresh → interactive", installAnswerMode({ hasAnswers: false, fresh: true, priorInstall: true }) === "interactive");

// Genuine first install (no prior compose .env) must ask, even without --fresh.
ok("first install → interactive", installAnswerMode({ hasAnswers: false, fresh: false, priorInstall: false }) === "interactive");

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
