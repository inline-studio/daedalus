// Smoke for `dae service ...`.
//   1. CLI surface: `service list`, `service install --dry-run` work
//   2. On Windows, the friendly "use WSL" error fires
//   3. The systemd renderer produces the expected unit shape (tested directly so we
//      validate the Linux deploy target even when running on Windows)
//   4. The launchd renderer produces a valid plist shape

import { spawnSync } from "node:child_process";
import { SystemdManager } from "../dist/service/systemd.js";
import { LaunchdManager } from "../dist/service/launchd.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. CLI surface
const list = spawnSync("node", ["dist/index.js", "service", "list"], { encoding: "utf8" });
expect("service list contains daedalus", /^daedalus$/m.test(list.stdout));
expect("service list contains whisper", /^whisper$/m.test(list.stdout));

// 2. On Windows: install fires the unsupported error gracefully
if (process.platform === "win32") {
  const r = spawnSync("node", ["dist/index.js", "-c", "examples/daedalus.config.yaml", "service", "install", "--dry-run"], {
    encoding: "utf8",
  });
  expect(
    "windows: install errors with WSL guidance",
    r.status !== 0 && /WSL/.test(r.stderr),
    r.stderr.split("\n")[0],
  );
}

// 3. Systemd renderer (drives the manager directly so we can validate Linux targets from any OS)
const sd = new SystemdManager();
const sdResult = await sd.install(
  {
    name: "daedalus",
    description: "Artemis runner",
    exec: "/usr/bin/node",
    args: ["/home/user/dist/index.js", "-c", "/home/user/.daedalus/config.yaml", "serve"],
    workingDir: "/home/user/.daedalus",
    restart: "on-failure",
    restartDelaySec: 5,
    env: { NODE_ENV: "production" },
  },
  { dryRun: true },
);
const unit = sdResult.unitContent;
expect("systemd: [Unit] section",         /^\[Unit\]$/m.test(unit));
expect("systemd: ExecStart correct",      /ExecStart=\/usr\/bin\/node \/home\/user\/dist\/index\.js -c \/home\/user\/\.daedalus\/config\.yaml serve/.test(unit));
expect("systemd: Restart=on-failure",     /Restart=on-failure/.test(unit));
expect("systemd: RestartSec=5",           /RestartSec=5/.test(unit));
expect("systemd: WorkingDirectory",       /WorkingDirectory=\/home\/user\/\.daedalus/.test(unit));
expect("systemd: Environment line",       /Environment=NODE_ENV=production/.test(unit));
expect("systemd: WantedBy=default.target",/WantedBy=default\.target/.test(unit));
expect("systemd: notes mention enable-linger", sdResult.notes.some((n) => /enable-linger/.test(n)));

// 4. Launchd renderer
const ld = new LaunchdManager();
const ldResult = await ld.install(
  {
    name: "daedalus",
    description: "Artemis runner",
    exec: "/usr/local/bin/node",
    args: ["/Users/u/dist/index.js", "serve"],
    restart: "on-failure",
    env: { NODE_ENV: "production" },
  },
  { dryRun: true },
);
const plist = ldResult.unitContent;
expect("launchd: plist xml prolog",       plist.startsWith("<?xml"));
expect("launchd: Label com.daedalus.daedalus",  /<key>Label<\/key><string>com\.daedalus\.daedalus<\/string>/.test(plist));
expect("launchd: ProgramArguments has node", /<string>\/usr\/local\/bin\/node<\/string>/.test(plist));
expect("launchd: ProgramArguments has script",/<string>\/Users\/u\/dist\/index\.js<\/string>/.test(plist));
expect("launchd: KeepAlive true (restart != no)", /<key>KeepAlive<\/key><true\/>/.test(plist));
expect("launchd: RunAtLoad true",          /<key>RunAtLoad<\/key><true\/>/.test(plist));
expect("launchd: EnvironmentVariables block", /<key>EnvironmentVariables<\/key>/.test(plist));
expect("launchd: NODE_ENV value",          /<key>NODE_ENV<\/key><string>production<\/string>/.test(plist));

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
