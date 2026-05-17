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
  const parse = (v: string) => v.replace(/^v/, "").split(".").map(Number);
  const [aMaj = 0, aMin = 0, aPat = 0] = parse(a);
  const [bMaj = 0, bMin = 0, bPat = 0] = parse(b);
  if (aMaj !== bMaj) return aMaj > bMaj;
  if (aMin !== bMin) return aMin > bMin;
  return aPat > bPat;
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
    console.log(`\n✓ Updated to v${latest}. Restart any running \`dae serve\` processes.`);
  } catch (err) {
    console.error(`\nInstall failed: ${(err as Error).message}`);
    process.exit(1);
  }
}
