import path from "node:path";
import { createRequire } from "node:module";
import { execa } from "execa";
import {
  findComposeFile,
  refreshComposeAssets,
  localWhisperEnabled,
  computeComposeProfiles,
  provisionGraphitiProxy,
  waitForOnecli,
} from "../install.js";
import { loadConfig } from "../config/load.js";
import { upsertEnvFile } from "../setup/env-file.js";

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
      "\n(no installed stack found — run `dae install` to set up and start the containers)",
    );
    return;
  }
  const composeDir = path.dirname(composeFile);
  const envPath = path.join(composeDir, ".env");
  // Re-pack the just-updated CLI into the build context so --build actually
  // rebuilds the image from the new version (not the stale tarball from install).
  await refreshComposeAssets(composeDir);

  // Keep the SAME services up across the rebuild. compose `up` without the profiles would
  // drop whichever isn't named — so transcription/memory would silently die after an
  // update. Derive the merged set from the config and persist COMPOSE_PROFILES so it
  // stays fixed (this also self-heals older installs that predate the persisted profile).
  let whisper = false;
  let graphiti = false;
  try {
    const cfg = loadConfig();
    whisper = localWhisperEnabled(cfg);
    graphiti = cfg.graphiti?.enabled === true || cfg.memory?.backend === "graphiti";
  } catch {
    // No/invalid config on the host — skip; default services still come up.
  }
  const profiles = computeComposeProfiles({ whisper, graphiti });
  await upsertEnvFile(envPath, { COMPOSE_PROFILES: profiles });

  // Graphiti reaches spark through the OneCLI proxy. Re-provision its proxy URL + CA so
  // the rebuild self-heals any drift (e.g. a rotated CA, or a .env predating Graphiti).
  // OneCLI must be up first; on an update the stack is already running, but bring it up
  // explicitly + wait to be safe. local-auth OneCLI ignores the token value.
  if (graphiti) {
    try {
      await execa("docker", ["compose", "-f", composeFile, "up", "-d", "onecli"], {
        stdio: "inherit",
        cwd: composeDir,
      });
      if (await waitForOnecli("http://localhost:10254")) {
        const proxyUrl = await provisionGraphitiProxy({
          baseUrl: "http://localhost:10254",
          apiKey: "dae-update", // local-auth OneCLI ignores the value
          caPath: path.join(composeDir, "onecli-ca.pem"),
        });
        if (proxyUrl) await upsertEnvFile(envPath, { ONECLI_PROXY_URL: proxyUrl });
      } else {
        console.error("⚠ OneCLI didn't come up — skipping Graphiti proxy refresh.");
      }
    } catch (err) {
      console.error(`⚠ Couldn't refresh Graphiti's OneCLI proxy: ${(err as Error).message}`);
    }
  }

  // Profiles come from COMPOSE_PROFILES in the compose .env (persisted above + read
  // automatically), so `up` brings up the right services without a `--profile` flag.
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
