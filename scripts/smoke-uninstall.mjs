// Smoke for `dae uninstall`. Can't drive the full flow without a real install +
// services + secrets — instead, verifies the command is registered, --help
// lists the key flags, and the safety guard fires when no --yes is given.

import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. `dae uninstall --help` lists the key opt flags.
{
  const r = spawnSync("node", ["dist/index.js", "uninstall", "--help"], { encoding: "utf8" });
  const out = (r.stdout ?? "") + (r.stderr ?? "");
  expect("uninstall --help exits 0", r.status === 0, `status=${r.status}`);
  expect(
    "uninstall --help mentions --purge",
    /--purge\b/.test(out),
    `out: ${out.slice(0, 200)}`,
  );
  expect(
    "uninstall --help mentions -y / --yes",
    /-y|--yes\b/.test(out),
    `out: ${out.slice(0, 200)}`,
  );
  expect(
    "uninstall --help is upfront about stopping the stack",
    /stop|down|purge|delete/i.test(out),
    `out: ${out.slice(0, 200)}`,
  );
}

// 2. Top-level `dae --help` advertises uninstall alongside install (so users
// who know `dae install` can discover it).
{
  const r = spawnSync("node", ["dist/index.js", "--help"], { encoding: "utf8" });
  const out = r.stdout ?? "";
  expect("dae --help includes uninstall in the command list", /\buninstall\b/.test(out), `out tail: ${out.slice(out.length - 400)}`);
  expect("dae --help still includes install (regression guard)", /\binstall\b/.test(out));
}

// 3. Without --yes, the safety prompt fires immediately. We pipe an empty
// stdin so the confirm() falls back to its default (no = cancel), giving us a
// deterministic "Cancelled." exit without poking real services.
{
  const r = spawnSync("node", ["dist/index.js", "uninstall"], {
    encoding: "utf8",
    input: "\n",
  });
  const combined = (r.stdout ?? "") + (r.stderr ?? "");
  expect(
    "uninstall (no --yes) surfaces the warning + prompts; exits without crash",
    r.status === 0 && /stops the daedalus stack/i.test(combined),
    `status=${r.status}, out first 400B: ${combined.slice(0, 400)}`,
  );
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
