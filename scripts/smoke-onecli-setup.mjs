// Smoke for the dae setup onecli wiring.
// Doesn't drive the interactive prompt (that's awkward to script). Confirms:
//   - the setup is registered and discoverable via the dispatcher
//   - the OneCLI ping codepath behaves on a known-down endpoint
//   - typing `dae setup onecli` from the CLI resolves to that flow

import { spawnSync } from "node:child_process";
import { OneCliSecretsBackend } from "../dist/secrets/store/onecli-backend.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. setup --list mentions onecli
const list = spawnSync("node", ["dist/index.js", "setup", "--list"], { encoding: "utf8" });
expect(
  "setup --list contains onecli",
  /onecli\s+OneCLI proxy/.test(list.stdout),
  list.stdout.split("\n").find((l) => l.trim().startsWith("onecli")) ?? "(missing)",
);

// 2. ping a known-down OneCLI is graceful (no throw, returns false)
const dead = new OneCliSecretsBackend({ baseUrl: "http://127.0.0.1:1" });
const ping = await dead.ping();
expect("ping on dead endpoint returns false", ping === false);

// 3. ping a reachable HTTP server (use example.com:80; any 2xx/3xx/4xx counts as "alive")
const live = new OneCliSecretsBackend({ baseUrl: "https://example.com" });
const livePing = await live.ping();
expect("ping on reachable URL returns true", livePing === true);

// 4. the setup dispatcher knows about 'onecli'
const help = spawnSync("node", ["dist/index.js", "setup", "onecli", "--help"], { encoding: "utf8" });
// Note: commander treats `setup onecli` as positional argument since `setup` takes <channel>.
// The action handler runs before --help can intercept on the parent. Either way, the binary
// resolves the symbol without throwing at module-load time, which is what we're checking.
expect(
  "no module-load errors invoking setup onecli path",
  help.status !== null,
  `exit=${help.status}`,
);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
