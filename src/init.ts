import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import prompts from "prompts";

// Bootstrap a usable per-user config at ~/.daedalus/config.yaml, copying defaults from the
// shipped example. Idempotent — refuses to overwrite an existing config unless --force.
export async function initUserConfig(opts: { force?: boolean } = {}): Promise<void> {
  const userDir = path.join(os.homedir(), ".daedalus");
  const targetConfig = path.join(userDir, "config.yaml");

  // Locate the bundled example. dist/init.js → ../examples/daedalus.config.yaml.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const examplePath = path.resolve(here, "..", "examples", "daedalus.config.yaml");
  const exampleBrain = path.resolve(here, "..", "examples", "brain");

  const exists = await fileExists(targetConfig);
  if (exists && !opts.force) {
    console.log(`Config already exists at ${targetConfig}.`);
    console.log("Use --force to overwrite, or edit the file directly.");
    return;
  }

  let exampleText: string;
  try {
    exampleText = await fs.readFile(examplePath, "utf8");
  } catch (err) {
    throw new Error(
      `Couldn't read shipped example config at ${examplePath}: ${(err as Error).message}. ` +
        "Did you forget to run npm install / npm run build?",
    );
  }

  const linkBrain = await prompts({
    type: "confirm",
    name: "ok",
    message: `Create a starter brain at ${path.join(userDir, "brain")} (copy of the example)?`,
    initial: true,
  });

  await fs.mkdir(userDir, { recursive: true });

  let configText = exampleText;
  if (linkBrain.ok) {
    const targetBrain = path.join(userDir, "brain");
    await copyDir(exampleBrain, targetBrain);
    configText = configText.replace(/path:\s*\.\/brain/, `path: ${posix(targetBrain)}`);
    console.log(`✓ copied brain → ${targetBrain}`);
  } else {
    console.log(`(skipped brain copy — set brain.path in ${targetConfig} manually)`);
  }

  await fs.writeFile(targetConfig, configText, "utf8");
  console.log(`✓ wrote ${targetConfig}`);
  console.log(`\nNext: run \`dae agents\` to confirm everything loads.`);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyDir(src: string, dest: string): Promise<void> {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

function posix(p: string): string {
  return p.replaceAll("\\", "/");
}
