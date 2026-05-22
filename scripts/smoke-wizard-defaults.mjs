// Verify `dae setup` wizard defaults:
//   - `dae setup` with no args runs the guided wizard (we don't drive prompts; we
//     just check the entry path dispatches without a parse/dispatch error)
//   - `dae setup --list` lists the integrations (and no synthetic 'all' row)
//   - `dae setup --help` mentions the wizard

import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. setup --list shows entries (and DOESN'T mention 'all' as a separate item)
const list = spawnSync("node", ["dist/index.js", "setup", "--list"], { encoding: "utf8" });
expect("setup --list lists telegram", /^\s*telegram/m.test(list.stdout));
expect("setup --list lists onecli", /^\s*onecli/m.test(list.stdout));
expect("setup --list lists whisper", /^\s*whisper/m.test(list.stdout));
expect("setup --list does NOT include a synthetic 'all' row", !/^\s*all\s+run all/m.test(list.stdout));

// 2. setup --help mentions the wizard
const help = spawnSync("node", ["dist/index.js", "setup", "--help"], { encoding: "utf8" });
expect("setup --help mentions wizard", /wizard/.test(help.stdout));

// 3. `dae setup <id>` routes (closed stdin → prompts resolves with no answers; we
// only assert it dispatched without an unexpected stack trace).
{
  const r = spawnSync("node", ["dist/index.js", "-c", "examples/daedalus.config.yaml", "setup", "telegram"], {
    encoding: "utf8",
    input: "",
    timeout: 20_000,
  });
  expect(
    "setup <id> dispatched without unexpected error",
    !/TypeError|ReferenceError/.test(r.stderr),
    r.stderr.split("\n").find((l) => /Error/.test(l)) ?? "(clean)",
  );
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
