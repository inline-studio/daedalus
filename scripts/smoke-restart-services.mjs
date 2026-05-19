// Smoke for restartAllActiveServices — the helper `dae update` now calls so
// every installed-and-active daedalus service picks up new code.
//
// We can't exercise a live systemctl here (CI doesn't have user-systemd in
// most environments and we don't want to install/uninstall real units in a
// test). What we CAN check:
//   - restartSupervisorIfActive + restartAllActiveServices are exported and
//     callable
//   - on a platform without a service manager (or with no installed units),
//     they short-circuit cleanly with a "nothing to restart" reason rather
//     than throwing

import {
  restartSupervisorIfActive,
  restartAllActiveServices,
} from "../dist/service/restart-supervisor.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. restartSupervisorIfActive returns a SupervisorRestartResult, never throws.
{
  let result;
  let threw = false;
  try {
    result = await restartSupervisorIfActive(undefined);
  } catch (err) {
    threw = true;
    expect("restartSupervisorIfActive did not throw", false, (err).message);
  }
  if (!threw) {
    expect(
      "restartSupervisorIfActive returns a shaped result",
      typeof result?.attempted === "boolean" &&
        typeof result?.restarted === "boolean" &&
        typeof result?.reason === "string",
      `got: ${JSON.stringify(result)}`,
    );
    // On macOS dev box (no systemd) or any CI without the dae unit installed:
    // attempted+restarted are both false and reason explains why.
    expect(
      "no installed unit → restarted=false",
      result.restarted === false,
      `result: ${JSON.stringify(result)}`,
    );
  }
}

// 2. restartAllActiveServices returns an array, never throws.
{
  let results;
  let threw = false;
  try {
    results = await restartAllActiveServices(undefined);
  } catch (err) {
    threw = true;
    expect("restartAllActiveServices did not throw", false, (err).message);
  }
  if (!threw) {
    expect("restartAllActiveServices returns an array", Array.isArray(results));
    expect(
      "every entry has attempted/restarted/reason fields",
      results.every(
        (r) =>
          typeof r.attempted === "boolean" &&
          typeof r.restarted === "boolean" &&
          typeof r.reason === "string",
      ),
      `got: ${JSON.stringify(results)}`,
    );
    // On a dev machine / CI runner with no installed daedalus units, none
    // should be restarted (this is the common "fresh checkout" case).
    expect(
      "fresh checkout: nothing restarted",
      results.every((r) => !r.restarted),
      `got: ${JSON.stringify(results)}`,
    );
  }
}

// 3. The runUpdate dynamic import resolves (covers the "dist exists +
// restart-supervisor.js is a valid ESM module" basics; protects against a
// typo in the cli/update.ts import path).
{
  const updateMod = await import("../dist/cli/update.js");
  expect("runUpdate export exists", typeof updateMod.runUpdate === "function");
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
