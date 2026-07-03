import { createRequire } from "node:module";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { execa } from "execa";
import { findComposeFile } from "../install.js";

// True when the file exists and has any content — used to tell a completed install
// (compose .env written by `dae install`) apart from a bare compose file.
async function isNonEmptyFile(p: string): Promise<boolean> {
  try {
    return (await readFile(p, "utf8")).trim().length > 0;
  } catch {
    return false;
  }
}

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

// SEC-13: only accept a strict version tag before using it to build the artifact download URL,
// so a malformed/hostile GitHub API response can't steer the path. Matches vMAJOR.MINOR.PATCH
// with an optional -BUILD suffix (the project's tag shape, e.g. v0.1.0-134). Exported for tests.
export function isValidReleaseTag(tag: string): boolean {
  return /^v?\d+\.\d+\.\d+(?:-\d+)?$/.test(tag);
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

export async function runUpdate(opts: { check?: boolean; config?: string } = {}): Promise<void> {
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

  // SEC-13: validate the tag before it flows into the download URL / install command.
  if (!isValidReleaseTag(release.tag_name)) {
    process.stdout.write("failed\n");
    console.error(`Refusing to update: release tag '${release.tag_name}' is not a valid version string.`);
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

  // The npm update above only refreshed the host CLI. Now RE-APPLY the full deployment so the
  // containers rebuild AND any config migrations / new setup that shipped in this release land
  // automatically — keeping `dae update` one-and-done (no second command afterwards).
  //
  // "Installed" means a COMPLETED install: the compose file AND the .env `dae install` writes
  // beside it. A bare docker-compose.yml (a checkout cwd, leftovers from an abandoned setup)
  // must not drag a client-only machine — one that just runs `dae remote` against a server
  // elsewhere — into the interactive first-install wizard on every update.
  const composeFile = await findComposeFile();
  const installed = composeFile && (await isNonEmptyFile(path.join(path.dirname(composeFile), ".env")));
  if (!installed) {
    console.log(
      "\n(no installed stack on this machine — CLI update only." +
        "\n This is all a `dae remote` client machine needs; to host the containers here, run `dae install`.)",
    );
    return;
  }
  // CRITICAL: re-EXEC the freshly-installed `dae`, rather than calling runInstall in-process.
  // This process is still the OLD CLI (Node can't hot-swap its own imported modules), so an
  // in-process re-apply would run the OLD install logic — new migrations and new prompts (e.g.
  // the web-login offer) would silently land one update late. Spawning the new binary runs the
  // NEW logic in the SAME update. `dae install` (no --fresh) reuses the existing config and only
  // asks for genuinely-new bits; stdio is inherited so any prompt is interactive.
  console.log("\nRe-applying your configuration with the updated CLI (lands migrations + any new setup)…\n");
  const args: string[] = [];
  if (opts.config) args.push("-c", opts.config);
  args.push("install");
  try {
    await execa("dae", args, { stdio: "inherit" });
  } catch (err) {
    console.error(`\nRe-apply failed: ${(err as Error).message}`);
    console.error("Run `dae install` to finish applying the update.");
    process.exit(1);
  }
}
