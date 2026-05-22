// Verify `dae install` is wired correctly. It's now a thin orchestrator around
// docker compose, so we don't drive it end-to-end here (that needs a docker
// daemon and would mutate config + write a compose .env). We just confirm the
// command is registered and its --help describes the docker-compose flow.

import { spawnSync } from "node:child_process";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. install appears in top-level help
const help = spawnSync("node", ["dist/index.js", "--help"], { encoding: "utf8" });
expect("top-level --help mentions install", /\binstall\b/.test(help.stdout));

// 2. install --help describes the docker-compose bring-up
const installHelp = spawnSync("node", ["dist/index.js", "install", "--help"], { encoding: "utf8" });
expect(
  "install --help mentions docker compose",
  /docker compose/i.test(installHelp.stdout),
  installHelp.stdout.slice(0, 200),
);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
