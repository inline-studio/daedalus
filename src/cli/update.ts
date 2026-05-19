import { createRequire } from "node:module";
import { execa } from "execa";

const REPO = "inline-studio/daedalus";

interface GithubRelease {
  tag_name: string;
  html_url: string;
}

function currentVersion(): string {
  const require = createRequire(import.meta.url);
  // dist/cli/update.js → ../../package.json
  const pkg = require("../../package.json") as { version: string };
  return pkg.version;
}

function semverGt(a: string, b: string): boolean {
  const parse = (v: string) => {
    const s = v.replace(/^v/, "");
    const dash = s.indexOf("-");
    const base = dash >= 0 ? s.slice(0, dash) : s;
    const build = dash >= 0 ? parseInt(s.slice(dash + 1), 10) : 0;
    const [maj = 0, min = 0, pat = 0] = base.split(".").map(Number);
    return { maj, min, pat, build };
  };
  const av = parse(a);
  const bv = parse(b);
  if (av.maj !== bv.maj) return av.maj > bv.maj;
  if (av.min !== bv.min) return av.min > bv.min;
  if (av.pat !== bv.pat) return av.pat > bv.pat;
  return av.build > bv.build;
}

export async function runUpdate(opts: { check?: boolean } = {}): Promise<void> {
  const current = currentVersion();
  process.stdout.write(`Current version: v${current}\nChecking GitHub for updates… `);

  let release: GithubRelease;
  try {
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { "User-Agent": "daedalus-cli" },
    });
    if (!res.ok) throw new Error(`GitHub API returned HTTP ${res.status}`);
    release = (await res.json()) as GithubRelease;
  } catch (err) {
    process.stdout.write("failed\n");
    console.error(`Could not check for updates: ${(err as Error).message}`);
    process.exit(1);
  }

  const latest = release.tag_name.replace(/^v/, "");
  process.stdout.write(`latest is v${latest}\n\n`);

  if (!semverGt(latest, current)) {
    console.log(`Already up to date.`);
    return;
  }

  console.log(`Update available: v${current} → v${latest}`);
  console.log(`Release notes: ${release.html_url}`);

  if (opts.check) return;

  const tarball = `https://github.com/${REPO}/releases/download/v${latest}/daedalus-${latest}.tgz`;
  console.log(`\nInstalling v${latest}…\n`);
  try {
    await execa("npm", ["install", "-g", tarball], { stdio: "inherit" });
  } catch (err) {
    console.error(`\nInstall failed: ${(err as Error).message}`);
    process.exit(1);
  }

  console.log(`\n✓ Updated to v${latest}.`);

  // Restart every daedalus-managed service that's currently installed + active
  // so the live `dae serve` (and any sidecars like dae-whisper / dae-mempalace)
  // actually load the new code instead of running yesterday's binary.
  // Non-fatal — a missing service manager just surfaces a friendly note.
  try {
    const { restartAllActiveServices } = await import("../service/restart-supervisor.js");
    const results = await restartAllActiveServices(undefined);
    const restarted = results.filter((r) => r.restarted);
    const skipped = results.filter((r) => !r.attempted);
    const failed = results.filter((r) => r.attempted && !r.restarted);
    if (restarted.length > 0) {
      console.log(`\nRestarted ${restarted.length} service(s):`);
      for (const r of restarted) console.log(`  ↻ ${r.reason}`);
    }
    if (failed.length > 0) {
      console.log(`\nFailed to restart:`);
      for (const r of failed) console.log(`  ✗ ${r.reason}`);
    }
    if (restarted.length === 0 && failed.length === 0) {
      // Either nothing's installed/active, or no service manager at all.
      // Surface the first non-attempted reason so the user knows.
      const sample = skipped[0];
      if (sample) console.log(`\n(no daedalus services restarted: ${sample.reason})`);
    }
  } catch (err) {
    console.error(`\nCould not restart services automatically: ${(err as Error).message}`);
    console.error(`Restart manually with: systemctl --user restart dae`);
  }
}
