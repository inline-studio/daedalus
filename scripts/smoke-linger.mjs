// Smoke for the linger module.
//
// Most paths through ensureLinger require either an actual systemd or sudo to
// reproduce — instead we exercise the things we CAN check on any platform:
//   - non-Linux short-circuits to action: "non-linux"
//   - non-interactive mode returns the manual-command hint without prompting
//
// The actual `sudo` + `loginctl` paths are covered by the manual checks in
// docs/docker-mode.md (and obviously by running it once on casa).

import os from "node:os";
import { ensureLinger, _resetLingerCacheForTests } from "../dist/service/linger.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. macOS / Windows: short-circuit, no prompts, no commands run.
if (os.platform() !== "linux") {
  _resetLingerCacheForTests();
  const r = await ensureLinger({});
  expect(
    "non-linux returns action='non-linux'",
    r.action === "non-linux" && r.status === "unknown",
    `got ${JSON.stringify(r)}`,
  );
  expect("non-linux returns no hint notes", r.notes.length === 0);
}

// 2. interactive: false → no prompt, returns "skipped" with the manual command.
//    Safe on Linux too: it only RUNS the loginctl status check, never sudo.
{
  _resetLingerCacheForTests();
  const r = await ensureLinger({ interactive: false, user: "test-user-that-doesnt-exist" });
  // On non-linux this still returns "non-linux" — accept either path.
  if (os.platform() !== "linux") {
    expect("non-interactive on non-linux still short-circuits", r.action === "non-linux");
  } else {
    expect(
      "non-interactive on linux returns 'skipped' (or 'already-enabled' if you really have a 'test-user-that-doesnt-exist' user with linger)",
      r.action === "skipped" || r.action === "already-enabled",
      `got ${JSON.stringify(r)}`,
    );
    if (r.action === "skipped") {
      expect(
        "skipped result includes the manual-command hint",
        r.notes.some((n) => /loginctl enable-linger/.test(n)),
        `notes: ${r.notes.join(" | ")}`,
      );
    }
  }
}

// 3. ensureLinger is callable without throwing when USER env is missing.
{
  _resetLingerCacheForTests();
  const savedUser = process.env.USER;
  delete process.env.USER;
  const r = await ensureLinger({ interactive: false });
  if (os.platform() !== "linux") {
    expect("missing USER on non-linux: still non-linux", r.action === "non-linux");
  } else {
    expect("missing USER on linux is handled (skipped, never throws)", r.action === "skipped");
  }
  if (savedUser !== undefined) process.env.USER = savedUser;
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
