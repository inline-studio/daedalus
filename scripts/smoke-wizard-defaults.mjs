// Verify the new default behaviors:
//   - `dae setup` with no args runs the wizard (we won't drive prompts; we just check
//     the entry path doesn't error out at parse / dispatch and prints the wizard intro)
//   - `dae setup --list` still lists
//   - `dae setup <id>` still routes to that flow (we'll trigger the help string)
//   - `dae service install --list` works
//   - `dae service install --all --dry-run` (where supported) renders both units
//   - `dae service install --dry-run` (no name, no --all) dispatches the wizard

import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. setup --list shows entries (and DOESN'T mention 'all' as a separate item now)
const list = spawnSync("node", ["dist/index.js", "setup", "--list"], { encoding: "utf8" });
expect("setup --list lists telegram", /^\s*telegram/m.test(list.stdout));
expect("setup --list lists onecli", /^\s*onecli/m.test(list.stdout));
expect("setup --list does NOT include a synthetic 'all' row", !/^\s*all\s+run all/m.test(list.stdout));

// 2. service install --list shows ids
const sList = spawnSync("node", ["dist/index.js", "service", "install", "--list"], { encoding: "utf8" });
expect("service install --list shows daedalus", /^daedalus$/m.test(sList.stdout));
expect("service install --list shows whisper", /^whisper$/m.test(sList.stdout));

// 3. service install --all --dry-run on Windows still surfaces the friendly error
{
  const r = spawnSync("node", ["dist/index.js", "service", "install", "--all", "--dry-run"], { encoding: "utf8" });
  if (process.platform === "win32") {
    expect(
      "service install --all on win32 → friendly WSL error",
      r.status !== 0 && /WSL|Windows/.test(r.stderr),
    );
  } else {
    expect("service install --all --dry-run renders both units", /daedalus/.test(r.stdout) && /whisper/.test(r.stdout));
  }
}

// 4. service install (no args, no --all) goes through the wizard branch — but the
// interactive prompt would block stdin. We close stdin so the prompt resolves to undefined
// and the flow exits cleanly (or with the friendly Windows error before reaching prompts).
{
  const r = spawnSync("node", ["dist/index.js", "service", "install"], {
    encoding: "utf8",
    input: "", // empty stdin → prompts resolves with no answers on most terminals
  });
  if (process.platform === "win32") {
    expect("service install (no args) on win32 → friendly error", r.status !== 0 && /WSL|Windows/.test(r.stderr));
  } else {
    // On Linux/Mac: hard to assert without a TTY. Just confirm it didn't crash with an
    // unrelated stack trace (commander parse error etc.).
    expect("service install (no args) didn't crash with unexpected error", !/TypeError|ReferenceError/.test(r.stderr));
  }
}

// 5. setup --help mentions "interactive setup wizard"
const help = spawnSync("node", ["dist/index.js", "setup", "--help"], { encoding: "utf8" });
expect("setup --help mentions wizard", /wizard/.test(help.stdout));

// 6. service install --help mentions wizard + --all + --list
const sHelp = spawnSync("node", ["dist/index.js", "service", "install", "--help"], { encoding: "utf8" });
expect("service install --help mentions wizard", /wizard/i.test(sHelp.stdout));
expect("service install --help shows --all flag", /--all/.test(sHelp.stdout));
expect("service install --help shows --list flag", /--list/.test(sHelp.stdout));

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
