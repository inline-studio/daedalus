// Smoke for runtime/setup-ssh.sh — the agent container's per-startup SSH wiring.
//
// What's under test: when the operator drops an ssh key into <configDir>/ssh/ on
// the host, the supervisor's bind-mount surfaces it at /etc/daedalus/ssh/ inside
// every agent container. setup-ssh.sh symlinks it into $HOME/.ssh/ and writes a
// minimal ~/.ssh/config with StrictModes disabled (the host file's uid almost
// never matches the container's uid, and the check is guarding against a threat
// that doesn't apply to a path we control).
//
// Why this is a smoke not a unit test: it's a /bin/sh script. We drive it from
// Node by setting $DAE_SSH_HOST_DIR + $HOME and shelling out. No Docker needed —
// the script itself is environment-agnostic.
//
// Covered:
//   1. No-op when the host hasn't placed keys (the opt-in path).
//   2. Each file in <host>/ssh/ gets symlinked into $HOME/.ssh/.
//   3. $HOME/.ssh/config gets the StrictModes-no block.
//   4. Re-running is idempotent (no duplicate config; no symlink churn).
//   5. Pre-existing $HOME/.ssh/<name> is NOT overwritten (agent's config wins).
//   6. Pre-existing $HOME/.ssh/config is NOT overwritten (ditto).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SHIM = path.resolve("runtime/setup-ssh.sh");
let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmps = [];
const mktmp = (label) => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), `dae-shim-${label}-`));
  tmps.push(p);
  return p;
};

// Run the shim with $HOME + $DAE_SSH_HOST_DIR pointed at scratch dirs. We
// can't `source` a shell script from Node, so we exec a tiny sh wrapper that
// dot-sources the real file — same code path the entrypoint uses.
function runShim({ home, hostDir }) {
  const r = spawnSync(
    "sh",
    ["-c", `. "${SHIM}"`],
    {
      env: { ...process.env, HOME: home, DAE_SSH_HOST_DIR: hostDir },
      encoding: "utf8",
    },
  );
  if (r.status !== 0) {
    throw new Error(`shim exited ${r.status}: ${r.stderr || r.stdout}`);
  }
  return r;
}

// ---------- 1. host hasn't placed keys → no-op -------------------------------
{
  const home = mktmp("home-noop");
  const hostDir = path.join(mktmp("cfg-noop"), "ssh"); // intentionally missing
  runShim({ home, hostDir });
  expect("no key dir on host → $HOME/.ssh is not created", !fs.existsSync(path.join(home, ".ssh")));
}

// ---------- 2. keys land in $HOME/.ssh ---------------------------------------
{
  const home = mktmp("home-link");
  const cfg = mktmp("cfg-link");
  const hostSsh = path.join(cfg, "ssh");
  fs.mkdirSync(hostSsh);
  fs.writeFileSync(path.join(hostSsh, "id_ed25519"), "FAKE_PRIVATE_KEY\n", { mode: 0o600 });
  fs.writeFileSync(path.join(hostSsh, "id_ed25519.pub"), "FAKE_PUBLIC_KEY\n", { mode: 0o644 });
  fs.writeFileSync(path.join(hostSsh, "known_hosts"), "github.com ssh-ed25519 AAAA…\n", { mode: 0o644 });

  runShim({ home, hostDir: hostSsh });

  const homeSsh = path.join(home, ".ssh");
  expect("$HOME/.ssh exists", fs.existsSync(homeSsh));
  expect("$HOME/.ssh is 0700", (fs.statSync(homeSsh).mode & 0o777) === 0o700);

  for (const name of ["id_ed25519", "id_ed25519.pub", "known_hosts"]) {
    const link = path.join(homeSsh, name);
    expect(
      `${name} is a symlink to the host file`,
      fs.lstatSync(link).isSymbolicLink() && fs.readlinkSync(link) === path.join(hostSsh, name),
    );
    expect(
      `${name} resolves through the symlink and is readable`,
      fs.readFileSync(link, "utf8") === fs.readFileSync(path.join(hostSsh, name), "utf8"),
    );
  }

  // ------- 3. config carries the StrictModes line --------------------------
  const cfgFile = path.join(homeSsh, "config");
  const cfgBody = fs.readFileSync(cfgFile, "utf8");
  expect("~/.ssh/config has Host * StrictModes no", /Host \*[\s\S]*StrictModes no/.test(cfgBody));
  expect("~/.ssh/config is 0600", (fs.statSync(cfgFile).mode & 0o777) === 0o600);

  // ------- 4. idempotent: run twice, no duplication ------------------------
  const beforeMtime = fs.statSync(path.join(homeSsh, "id_ed25519")).mtimeMs;
  const beforeConfig = fs.readFileSync(cfgFile, "utf8");
  runShim({ home, hostDir: hostSsh });
  expect("re-run leaves symlink untouched", fs.statSync(path.join(homeSsh, "id_ed25519")).mtimeMs === beforeMtime);
  expect("re-run leaves config byte-identical", fs.readFileSync(cfgFile, "utf8") === beforeConfig);
}

// ---------- 5. agent's pre-existing key is NOT overwritten -------------------
{
  const home = mktmp("home-agentwins");
  const hostSsh = path.join(mktmp("cfg-agentwins"), "ssh");
  fs.mkdirSync(hostSsh);
  fs.writeFileSync(path.join(hostSsh, "id_ed25519"), "HOST_KEY\n");

  // Agent has already written its own key with the same name.
  const homeSsh = path.join(home, ".ssh");
  fs.mkdirSync(homeSsh, { mode: 0o700 });
  fs.writeFileSync(path.join(homeSsh, "id_ed25519"), "AGENT_KEY\n", { mode: 0o600 });

  runShim({ home, hostDir: hostSsh });

  const survivor = fs.readFileSync(path.join(homeSsh, "id_ed25519"), "utf8");
  expect(
    "pre-existing $HOME/.ssh/id_ed25519 wins over the host file",
    survivor === "AGENT_KEY\n" && !fs.lstatSync(path.join(homeSsh, "id_ed25519")).isSymbolicLink(),
  );
}

// ---------- 6. agent's pre-existing config is NOT overwritten ----------------
{
  const home = mktmp("home-cfgwins");
  const hostSsh = path.join(mktmp("cfg-cfgwins"), "ssh");
  fs.mkdirSync(hostSsh);
  fs.writeFileSync(path.join(hostSsh, "id_ed25519"), "HOST_KEY\n");

  const homeSsh = path.join(home, ".ssh");
  fs.mkdirSync(homeSsh, { mode: 0o700 });
  const customConfig = "# agent's custom config\nHost github.com\n  User git\n";
  fs.writeFileSync(path.join(homeSsh, "config"), customConfig, { mode: 0o600 });

  runShim({ home, hostDir: hostSsh });

  expect(
    "pre-existing $HOME/.ssh/config wins over the generated one",
    fs.readFileSync(path.join(homeSsh, "config"), "utf8") === customConfig,
  );
  // but the symlink still gets placed since that name was free
  expect("new key still gets symlinked when only config was present", fs.lstatSync(path.join(homeSsh, "id_ed25519")).isSymbolicLink());
}

// ---------- teardown ---------------------------------------------------------
for (const d of tmps) fs.rmSync(d, { recursive: true, force: true });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
