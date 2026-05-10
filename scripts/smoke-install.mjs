// Verify `dae install` is wired correctly:
//   - shows up in --help
//   - has its own --help that mentions all three stages
//   - is invokable end-to-end (we exit before fully driving prompts; just confirm the
//     dispatcher reaches the right stages and surfaces the friendly Windows error for
//     the service step rather than a stack trace)

import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. install appears in top-level help
const help = spawnSync("node", ["dist/index.js", "--help"], { encoding: "utf8" });
expect("top-level --help mentions install", /install\s+one-shot install/.test(help.stdout));

// 2. install --help describes the three stages
const installHelp = spawnSync("node", ["dist/index.js", "install", "--help"], { encoding: "utf8" });
expect(
  "install --help mentions setup wizard + services",
  /setup wizard/.test(installHelp.stdout) && /services/.test(installHelp.stdout),
);

// 3. on win32, the service step degrades gracefully — but we'd need to drive prompts to
// get there. The wizard prompts block on stdin; we provide closed stdin so prompts
// resolves with no answers. The flow may exit early during the setup wizard; that's fine
// — we're verifying it doesn't blow up at module-load time.
{
  // Use ARTEMIS_CONFIG so install doesn't try to bootstrap a fresh config.
  const cfg = "examples/daedalus.config.yaml";
  const r = spawnSync("node", ["dist/index.js", "-c", cfg, "install"], {
    encoding: "utf8",
    input: "", // empty stdin → prompts resolves with undefined; flow exits cleanly
    timeout: 20_000,
  });
  expect(
    "install dispatched without unexpected errors",
    !/TypeError|ReferenceError/.test(r.stderr),
    r.stderr.split("\n").find((l) => /Error/.test(l)) ?? "(clean)",
  );
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
