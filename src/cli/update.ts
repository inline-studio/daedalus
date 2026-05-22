import path from "node:path";
import { createRequire } from "node:module";
import { execa } from "execa";
import { findComposeFile, refreshComposeAssets } from "../install.js";

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

  console.log(`\n✓ Updated the dae CLI to v${latest}.`);

  // The live stack runs as containers built from the daedalus image — the npm
  // update above only refreshed the host CLI. Rebuild + restart the containers so
  // they pick up the new code, reusing the existing compose .env (no re-prompting).
  const composeFile = await findComposeFile();
  if (!composeFile) {
    console.log(
      "\n(no docker-compose.yml found — rebuild the stack manually with `docker compose up -d --build`)",
    );
    return;
  }
  const composeDir = path.dirname(composeFile);
  // Re-pack the just-updated CLI into the build context so --build actually
  // rebuilds the image from the new version (not the stale tarball from install).
  await refreshComposeAssets(composeDir);
  const args = ["compose", "-f", composeFile, "up", "-d", "--build"];
  console.log(`\nRebuilding the stack:\n$ docker ${args.join(" ")}\n`);
  try {
    await execa("docker", args, { stdio: "inherit", cwd: composeDir });
    console.log("\n✓ Stack rebuilt and restarted.");
  } catch (err) {
    console.error(`\nStack rebuild failed: ${(err as Error).message}`);
    console.error("Rebuild manually with: docker compose up -d --build");
  }
}
