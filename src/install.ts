import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { loadConfig } from "./config/load.js";
import { initUserConfig } from "./init.js";
import { confirm } from "./setup/base.js";
import { secretPrompt } from "./setup/secret-prompt.js";
import { editYamlFile, setIn } from "./setup/yaml-edit.js";
import { upsertEnvFile } from "./setup/env-file.js";

// `dae install` — the one turnkey command. It is a thin orchestrator around
// docker compose: it makes sure a config exists, asks the *only* three questions
// that can't be inferred, writes the config + the compose `.env`, then runs
// `docker compose up -d` to bring up the whole stack (supervisor + scheduler,
// mempalace memory, and — if asked — a local whisper STT container).
//
// Everything runs in containers; there is no host service to install. `dae run`
// remains the host-side one-shot for local testing.

const TELEGRAM_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

export async function runInstall(configFlag?: string): Promise<void> {
  // 1. Ensure a config exists; offer to bootstrap one if not.
  const configPath = await ensureConfig(configFlag);
  if (!configPath) return;

  const configDir = path.dirname(configPath);
  const envLocalPath = path.join(configDir, ".env.local");
  const config = loadConfig(configPath);
  const brainPath = config.brain.path; // already resolved to an absolute host path
  const defaultAgent = config.channels?.cli?.defaultAgent ?? "orchestrator";

  // Locate the compose file up front so we can pre-fill answers from a previous
  // install's .env ("leave blank to keep") and bring the stack up at the end.
  const composeFile = await findComposeFile();
  const composeEnvPath = composeFile ? path.join(path.dirname(composeFile), ".env") : null;
  const prev = composeEnvPath ? await readEnvFile(composeEnvPath) : {};
  const prevMempalaceToken = prev.MEMPALACE_TOKEN ?? process.env.MEMPALACE_TOKEN ?? "";
  const prevOnecliKey = prev.ONECLI_API_KEY ?? process.env.ONECLI_API_KEY ?? "";

  // 2. The questions. Everything else is inferred; memory + onecli always run.
  console.log("\nDaedalus runs entirely in docker containers. A few questions:\n");

  const wantWhisper = await confirm(
    "Run a local Whisper container for voice-note transcription?",
    false,
  );

  const tgRaw =
    (await secretPrompt({
      message: "Telegram bot token from @BotFather (leave blank to skip Telegram):",
    })) ?? "";
  const tgToken = tgRaw.trim();
  if (tgToken && !TELEGRAM_TOKEN_RE.test(tgToken)) {
    console.log("  ⚠ that doesn't look like a Telegram bot token — skipping Telegram setup.");
  }
  const enableTelegram = Boolean(tgToken) && TELEGRAM_TOKEN_RE.test(tgToken);

  const authMsg = prevMempalaceToken
    ? "Require an auth token for the memory (mempalace) server? (a token is already set)"
    : "Require an auth token for the memory (mempalace) server?";
  const wantAuth = await confirm(authMsg, Boolean(prevMempalaceToken));
  let mempalaceToken = "";
  if (wantAuth) {
    const typed =
      ((await secretPrompt({
        message: prevMempalaceToken
          ? "MemPalace bearer token (leave blank to keep the existing one):"
          : "MemPalace bearer token (leave blank to generate a random one):",
      })) ?? "").trim();
    mempalaceToken = typed || prevMempalaceToken;
    if (!mempalaceToken) {
      mempalaceToken = randomBytes(24).toString("base64url");
      console.log("  generated a random MemPalace token (saved to your .env files).");
    }
  }

  // OneCLI credential gateway runs as part of the stack regardless. Supplying its
  // daemon API key wires daedalus to use it; leaving it blank runs OneCLI disabled.
  const typedOnecli =
    ((await secretPrompt({
      message: prevOnecliKey
        ? "OneCLI daemon API key (oc_...) — leave blank to keep the existing one:"
        : "OneCLI daemon API key (oc_...) — leave blank to run OneCLI disabled for now:",
    })) ?? "").trim();
  const onecliKey = typedOnecli || prevOnecliKey;

  // 3. Persist config + runner secrets.
  const yamlEdits: Array<{ keyPath: string[]; value: unknown }> = [
    // Memory: always the containerised mempalace, reached by service name.
    { keyPath: ["memory", "backend"], value: "mempalace" },
    { keyPath: ["mempalace", "localHttp", "enabled"], value: true },
    { keyPath: ["mempalace", "localHttp", "host"], value: "mempalace" },
    { keyPath: ["mempalace", "localHttp", "port"], value: 11364 },
    { keyPath: ["mempalace", "localHttp", "urlPath"], value: "/mcp" },
  ];
  const runnerEnv: Record<string, string> = {};

  if (wantWhisper) {
    yamlEdits.push(
      { keyPath: ["transcribe", "backend"], value: "openai-whisper" },
      { keyPath: ["transcribe", "baseUrl"], value: "http://whisper:8000/v1" },
      { keyPath: ["transcribe", "model"], value: "Systran/faster-whisper-large-v3" },
      { keyPath: ["transcribe", "apiKey"], value: "local-no-auth-required" },
    );
  }
  if (enableTelegram) {
    runnerEnv.TELEGRAM_BOT_TOKEN = tgToken;
    yamlEdits.push(
      { keyPath: ["channels", "telegram", "enabled"], value: true },
      { keyPath: ["channels", "telegram", "defaultAgent"], value: defaultAgent },
      { keyPath: ["channels", "telegram", "token"], value: "${TELEGRAM_BOT_TOKEN}" },
    );
  }
  if (mempalaceToken) runnerEnv.MEMPALACE_TOKEN = mempalaceToken;
  // OneCLI: enable in config + point at the in-stack gateway when we have a key.
  if (onecliKey) {
    yamlEdits.push(
      { keyPath: ["onecli", "enabled"], value: true },
      { keyPath: ["onecli", "baseUrl"], value: "http://onecli:10254" },
    );
  }

  await editYamlFile(configPath, (doc) => {
    for (const e of yamlEdits) setIn(doc, e.keyPath, e.value);
  });
  console.log(`\n✓ updated ${rel(configPath)}`);
  if (Object.keys(runnerEnv).length) {
    await upsertEnvFile(envLocalPath, runnerEnv);
    console.log(`✓ saved ${Object.keys(runnerEnv).join(", ")} to ${rel(envLocalPath)}`);
  }

  // 4. Write the compose `.env` (the ${...} interpolation vars docker-compose reads).
  if (!composeFile || !composeEnvPath) {
    console.log(
      "\nCouldn't find docker-compose.yml (run `dae install` from the daedalus repo, or copy " +
        "the compose file next to your config). Skipping the compose bring-up.",
    );
    return;
  }
  const composeDir = path.dirname(composeFile);
  const palacePath = path.join(os.homedir(), ".daedalus", "mempalace");
  await fs.mkdir(palacePath, { recursive: true });

  const composeEnv: Record<string, string> = {
    BRAIN_PATH: brainPath,
    DAEDALUS_CONFIG_DIR: configDir,
    MEMPALACE_PALACE_PATH: palacePath,
    UID: String(process.getuid?.() ?? 1000),
    DOCKER_GID: String(dockerGid()),
  };
  if (mempalaceToken) composeEnv.MEMPALACE_TOKEN = mempalaceToken;
  if (onecliKey) composeEnv.ONECLI_API_KEY = onecliKey;
  if (wantWhisper) composeEnv.WHISPER_PORT = "8000";

  await upsertEnvFile(composeEnvPath, composeEnv);
  console.log(`✓ wrote compose env → ${rel(composeEnvPath)}`);

  // 5. Bring the stack up. `--build` so from-source checkouts work without a
  //    published image; the whisper profile is only included when requested.
  const profileArgs = wantWhisper ? ["--profile", "whisper"] : [];
  const composeArgs = ["compose", "-f", composeFile, ...profileArgs, "up", "-d", "--build"];
  console.log(`\n$ docker ${composeArgs.join(" ")}\n`);
  try {
    await execa("docker", composeArgs, { stdio: "inherit", cwd: composeDir });
  } catch (err) {
    console.error(`\nCompose bring-up failed: ${(err as Error).message}`);
    console.error("Fix the issue above, then re-run `dae install` (it's idempotent).");
    process.exitCode = 1;
    return;
  }

  console.log("\n✓ Stack is up. Containers:");
  console.log("    daedalus   — supervisor + scheduler");
  console.log("    mempalace  — shared memory");
  console.log(`    onecli     — credential gateway${onecliKey ? "" : " (running, but disabled in config)"}`);
  if (wantWhisper) console.log("    whisper    — local speech-to-text");
  console.log("\nFollow the supervisor:  docker compose logs -f daedalus");
}

// Ensure a config file exists, bootstrapping one at ~/.daedalus/config.yaml if
// the user agrees. Returns the resolved config path, or null if cancelled.
async function ensureConfig(configFlag?: string): Promise<string | null> {
  const candidates = [
    configFlag,
    process.env.DAE_CONFIG,
    path.join(process.cwd(), "daedalus.config.yaml"),
    path.join(os.homedir(), ".daedalus", "config.yaml"),
  ].filter((p): p is string => Boolean(p));

  for (const c of candidates) {
    if (await exists(c)) return c;
  }

  console.log("No daedalus config found.");
  const ok = await confirm("Create one at ~/.daedalus/config.yaml from the example?", true);
  if (!ok) {
    console.log("Cancelled. Run `dae init` when you're ready, then `dae install` again.");
    return null;
  }
  await initUserConfig({});
  return path.join(os.homedir(), ".daedalus", "config.yaml");
}

// Locate docker-compose.yml: prefer the cwd (running from a checkout), then the
// package root (dist/install.js → ../docker-compose.yml).
export async function findComposeFile(): Promise<string | null> {
  const cwdCompose = path.join(process.cwd(), "docker-compose.yml");
  if (await exists(cwdCompose)) return cwdCompose;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgCompose = path.resolve(here, "..", "docker-compose.yml");
  if (await exists(pkgCompose)) return pkgCompose;
  return null;
}

// Best-effort gid of the group that owns the docker socket, so the supervisor
// container (run as ${UID}:${DOCKER_GID}) can talk to docker.sock. Falls back to
// the common default (998) when the socket can't be stat'd (e.g. macOS Docker
// Desktop, where the gid is irrelevant inside the VM).
function dockerGid(): number {
  for (const sock of ["/var/run/docker.sock", path.join(os.homedir(), ".docker", "run", "docker.sock")]) {
    try {
      return statSync(sock).gid;
    } catch {
      /* try next */
    }
  }
  return 998;
}

// Parse a .env file into a flat record (best-effort; ignores comments/blank lines).
// Used to pre-fill answers from a previous install ("leave blank to keep").
async function readEnvFile(filePath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let text: string;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let v = m[2]!.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]!] = v;
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function rel(p: string): string {
  const r = path.relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
}
