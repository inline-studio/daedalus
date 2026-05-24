import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import prompts from "prompts";
import { loadConfig } from "./config/load.js";
import { initUserConfig } from "./init.js";
import { confirm } from "./setup/base.js";
import { secretPrompt } from "./setup/secret-prompt.js";
import { editYamlFile, setIn, ensureMap } from "./setup/yaml-edit.js";
import { upsertEnvFile } from "./setup/env-file.js";
import { OneCliSecretsBackend } from "./secrets/store/onecli-backend.js";

// `dae install` — the one turnkey command. It is a thin orchestrator around
// docker compose: it makes sure a config exists, asks the *only* three questions
// that can't be inferred, writes the config + the compose `.env`, then runs
// `docker compose up -d` to bring up the whole stack (supervisor + scheduler,
// mempalace memory, and — if asked — a local whisper STT container).
//
// Everything runs in containers; there is no host service to install. You interact
// with your agents through a channel (Telegram/Web), not a host-side CLI command.

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

  // Compose project dir is a dedicated subdir of the config dir — kept separate so
  // the docker BUILD context (this dir) never includes the brain, memory data, or
  // .env.local secrets that live in the config dir itself. `dae install`
  // materialises the compose files + writes .env here. Pre-fill answers from a
  // previous install's .env ("leave blank to keep").
  const composeDir = path.join(configDir, "compose");
  const composeEnvPath = path.join(composeDir, ".env");
  const prev = await readEnvFile(composeEnvPath);
  const prevMempalaceToken = prev.MEMPALACE_TOKEN ?? process.env.MEMPALACE_TOKEN ?? "";
  const prevOnecliKey = prev.ONECLI_API_KEY ?? process.env.ONECLI_API_KEY ?? "";

  // 2. The questions. Everything else is inferred; memory + onecli always run.
  console.log("\nDaedalus runs entirely in docker containers. A few questions:\n");

  // 2a. LLM provider credentials — the one thing nothing works without. Each agent
  // picks its provider in its own frontmatter (provider: anthropic | openai), and a
  // brain can mix both, so we offer each independently. Keys are stored in OneCLI
  // (never on disk): the agent sends the `onecli-managed` placeholder and the gateway
  // swaps in the real key for the matching host at the proxy edge. Here we only enable
  // the provider block (+ record the openai base URL); the OneCLI registration runs
  // once the stack is up (step 6).
  const useAnthropic = await confirm(
    "Will any agent use Anthropic (Claude) directly at api.anthropic.com?",
    false,
  );
  const anthropicKey = useAnthropic
    ? ((await secretPrompt({ message: "Anthropic API key (sk-ant-…):" })) ?? "").trim()
    : "";
  if (useAnthropic && !anthropicKey) {
    console.log(
      "  ⚠ no Anthropic key entered — skipping. Add it later with:\n" +
        "    dae secret save ANTHROPIC_API_KEY -u api.anthropic.com -H x-api-key",
    );
  }

  const useOpenai = await confirm(
    "Will any agent use an OpenAI-compatible endpoint (OpenAI, LiteLLM, vLLM, Ollama …)?",
    false,
  );
  let openaiKey = "";
  let openaiBaseUrl = "";
  if (useOpenai) {
    const defaultBase = config.providers?.openai?.baseUrl ?? "https://api.openai.com/v1";
    openaiBaseUrl =
      (await textPrompt(`Base URL for that endpoint (must include /v1) [${defaultBase}]:`)) ||
      defaultBase;
    openaiKey = ((await secretPrompt({ message: "API key / token for that endpoint:" })) ?? "").trim();
    if (!openaiKey) {
      console.log(
        `  ⚠ no key entered — skipping. Add it later with:\n` +
          `    dae secret save OPENAI_API_KEY -u ${hostnameOf(openaiBaseUrl)} -H Authorization`,
      );
    }
  }

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

  // Brave web-search key. Stored in OneCLI (not on disk) and injected into
  // api.search.brave.com requests at the proxy edge — registered after the stack is up.
  const braveKey =
    ((await secretPrompt({
      message: "Brave Search API key for web_search (leave blank to skip / keep DuckDuckGo):",
    })) ?? "").trim();

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

  // OneCLI runs in the stack in local auth mode (open API on the daedalus network),
  // so we DON'T ask for a key — the supervisor creates its own agent and reads the
  // gateway config headlessly. daedalus still needs a non-empty ONECLI_API_KEY to
  // attempt the connection (local-mode onecli ignores its value), so generate one
  // and keep it stable across re-installs.
  const onecliKey = prevOnecliKey || randomBytes(24).toString("base64url");

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
      { keyPath: ["transcribe", "model"], value: "Systran/faster-whisper-small" },
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
  if (braveKey) {
    // The real key lives in OneCLI; the agent sends a placeholder that the gateway
    // swaps for the real X-Subscription-Token. The provider just needs a non-empty value.
    yamlEdits.push(
      { keyPath: ["web", "search", "provider"], value: "brave" },
      { keyPath: ["web", "search", "apiKey"], value: "onecli-managed" },
    );
  }
  // OpenAI-compatible provider: record the base URL so the config reflects the
  // endpoint we wired up. The key itself is NOT written here — it lives in OneCLI;
  // leaving providers.openai.apiKey unset makes resolveProviderKey fall through to
  // the OneCLI placeholder, which the gateway swaps for the real Bearer token.
  if (useOpenai && openaiKey) {
    yamlEdits.push({ keyPath: ["providers", "openai", "baseUrl"], value: openaiBaseUrl });
  }
  // OneCLI is always part of the stack — enable it + point at the in-stack gateway.
  yamlEdits.push(
    { keyPath: ["onecli", "enabled"], value: true },
    { keyPath: ["onecli", "baseUrl"], value: "http://onecli:10254" },
  );
  // Route top-level turns to the long-lived warm worker (dae-worker service) so each
  // message skips the per-turn container cold-start. Subagents still spawn containers.
  yamlEdits.push({ keyPath: ["runtime", "persistentAgent"], value: true });

  await editYamlFile(configPath, (doc) => {
    for (const e of yamlEdits) setIn(doc, e.keyPath, e.value);
    // Materialise the anthropic provider block (no leaf value — the key lives in
    // OneCLI) so it's visible/enabled, without clobbering an existing one.
    if (useAnthropic && anthropicKey) ensureMap(doc, ["providers", "anthropic"]);
  });
  console.log(`\n✓ updated ${rel(configPath)}`);
  if (Object.keys(runnerEnv).length) {
    await upsertEnvFile(envLocalPath, runnerEnv);
    console.log(`✓ saved ${Object.keys(runnerEnv).join(", ")} to ${rel(envLocalPath)}`);
  }

  // 4. Materialise the compose stack into the compose dir (so a global `dae`
  // install is self-contained, no repo checkout needed) and write the compose
  // `.env`. Also pack the installed CLI into the build context so the image is
  // built from THIS version (not whatever's released).
  const materialised = await materializeComposeFiles(composeDir);
  const composeFile = path.join(composeDir, "docker-compose.yml");
  if (!materialised || !(await exists(composeFile))) {
    console.log(
      "\nCouldn't find the bundled docker-compose.yml to install. Re-run from a daedalus " +
        "checkout, or copy docker-compose.yml + Dockerfile + Dockerfile.mempalace next to your config.",
    );
    return;
  }
  await packCliInto(composeDir);
  console.log(`✓ compose files → ${rel(composeDir)}`);

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
  composeEnv.ONECLI_API_KEY = onecliKey;
  // Persist the active compose profile so EVERY compose command (install, `dae update`,
  // manual `docker compose`) keeps the whisper container up — not just this install run.
  // Without this, `dae update` (which runs `compose up` with no --profile) drops whisper.
  composeEnv.COMPOSE_PROFILES = wantWhisper ? "whisper" : "";

  await upsertEnvFile(composeEnvPath, composeEnv);
  console.log(`✓ wrote compose env → ${rel(composeEnvPath)}`);

  // 5. Bring the stack up. `--build` builds the daedalus + mempalace images (the
  //    daedalus Dockerfile installs daedalus from the packed local CLI tarball we
  //    just dropped in the context). Whisper is only included on request.
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

  // 6. Register secrets in OneCLI now the gateway is up (daedalus depends on onecli
  //    being healthy, so by here it's ready). Stored in OneCLI, never on disk — the
  //    agent sends the `onecli-managed` placeholder and the gateway swaps in the real
  //    value for the matching host. LLM keys: anthropic via the x-api-key header,
  //    openai-compatible via Authorization: Bearer.
  const onecliSecrets: Array<{
    name: string;
    value: string;
    urlPattern: string;
    headerName: string;
    valueFormat: string;
    note: string;
  }> = [];
  if (braveKey) {
    onecliSecrets.push({
      name: "BRAVE_API_KEY",
      value: braveKey,
      urlPattern: "api.search.brave.com",
      headerName: "X-Subscription-Token",
      valueFormat: "{value}",
      note: "injected into api.search.brave.com requests",
    });
  }
  if (useAnthropic && anthropicKey) {
    onecliSecrets.push({
      name: "ANTHROPIC_API_KEY",
      value: anthropicKey,
      urlPattern: "api.anthropic.com",
      headerName: "x-api-key",
      valueFormat: "{value}",
      note: "injected into api.anthropic.com requests (x-api-key)",
    });
  }
  if (useOpenai && openaiKey) {
    const host = hostnameOf(openaiBaseUrl);
    onecliSecrets.push({
      name: "OPENAI_API_KEY",
      value: openaiKey,
      urlPattern: host,
      headerName: "Authorization",
      valueFormat: "Bearer {value}",
      note: `injected into ${host} requests (Authorization: Bearer)`,
    });
  }
  if (onecliSecrets.length) {
    const onecli = new OneCliSecretsBackend({ baseUrl: "http://localhost:10254", token: onecliKey });
    for (const s of onecliSecrets) {
      try {
        await onecli.save(s.name, s.value, {
          urlPattern: s.urlPattern,
          injectionConfig: { headerName: s.headerName, valueFormat: s.valueFormat },
        });
        console.log(`✓ registered ${s.name} in OneCLI (${s.note})`);
      } catch (err) {
        console.error(`\n⚠ Couldn't register ${s.name} in OneCLI: ${(err as Error).message}`);
        console.error(`  Once onecli is up, run: dae secret save ${s.name} -u ${s.urlPattern} -H ${s.headerName}`);
      }
    }
  }

  console.log("\n✓ Stack is up. Containers:");
  console.log("    daedalus   — supervisor + scheduler");
  console.log("    dae-worker — warm agent worker (handles top-level turns)");
  console.log("    mempalace  — shared memory");
  console.log("    onecli     — credential gateway (+ postgres)");
  if (wantWhisper) console.log("    whisper    — local speech-to-text");

  // Provider selection is per-agent, not global: the agent's frontmatter `provider:`
  // decides which credential it uses. Remind the user so the keys they just stored
  // actually get picked up.
  if (useAnthropic || useOpenai) {
    const enabled = [useAnthropic ? "anthropic" : null, useOpenai ? "openai" : null]
      .filter(Boolean)
      .join(" + ");
    console.log(`\nReminder: you enabled the ${enabled} provider${useAnthropic && useOpenai ? "s" : ""}.`);
    console.log("  Each agent chooses its provider in its own frontmatter — set");
    console.log("  `provider: <name>` (and a matching `model:`) in each brain/agents/<name>.md");
    console.log("  so it uses the key you just configured.");
  }

  console.log("\nFollow the supervisor:  docker compose logs -f daedalus");
}

// Free-text prompt (non-masked) — for non-secret answers like a base URL. Returns
// the trimmed value, or "" if the user cancelled / left it blank.
async function textPrompt(message: string): Promise<string> {
  const res = await prompts({ type: "text", name: "v", message });
  return ((res.v as string | undefined) ?? "").trim();
}

// Extract the host for a OneCLI host pattern from a base URL. Falls back to the raw
// string (sans scheme/path) if it doesn't parse as a URL.
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url.replace(/^[a-z]+:\/\//i, "").replace(/[/:].*$/, "");
  }
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

// The compose stack files shipped in the npm package (next to dist/). `dae install`
// copies these into the compose dir so a global install is self-contained.
const COMPOSE_FILES = ["docker-compose.yml", "Dockerfile", "Dockerfile.mempalace"];

// Restrict the docker build context to just the build inputs — never the compose
// .env (secrets), config, brain, or memory data that may sit nearby.
const DOCKERIGNORE = [
  "# Written by `dae install`. Keeps secrets/data out of the docker build context.",
  "*",
  "!Dockerfile",
  "!Dockerfile.mempalace",
  "!docker-compose.yml",
  "!daedalus-*.tgz",
  "",
].join("\n");

// The package root (dist/install.js → ..), where the bundled compose files live.
function bundleDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

// Copy the bundled compose files into `targetDir` (overwriting, to keep them in
// sync with the installed CLI version) and write a .dockerignore. Returns false if
// the bundle is missing (e.g. an old package without the files).
async function materializeComposeFiles(targetDir: string): Promise<boolean> {
  const src = bundleDir();
  await fs.mkdir(targetDir, { recursive: true });
  let copiedCompose = false;
  for (const name of COMPOSE_FILES) {
    const from = path.join(src, name);
    if (!(await exists(from))) continue;
    await fs.copyFile(from, path.join(targetDir, name));
    if (name === "docker-compose.yml") copiedCompose = true;
  }
  await fs.writeFile(path.join(targetDir, ".dockerignore"), DOCKERIGNORE, "utf8");
  return copiedCompose;
}

// Pack the installed daedalus CLI into the build context so the image is built
// from THIS exact version. Best-effort: on failure the Dockerfile falls back to
// the published release. --ignore-scripts skips the (dev-only) build prepare step.
async function packCliInto(targetDir: string): Promise<void> {
  // Clear any stale packed tarballs first (a leftover wrong-version one, or two
  // matching the Dockerfile glob, would break `npm install -g`).
  for (const f of await fs.readdir(targetDir).catch(() => [])) {
    if (/^daedalus-.*\.tgz$/.test(f)) await fs.rm(path.join(targetDir, f)).catch(() => undefined);
  }
  try {
    await execa(
      "npm",
      ["pack", "--ignore-scripts", "--pack-destination", targetDir, bundleDir()],
      { stdio: "ignore" },
    );
  } catch (err) {
    console.warn(
      `  (couldn't pack the local CLI — the image will build from the published release): ${(err as Error).message}`,
    );
  }
}

// Re-materialise the compose files + re-pack the installed CLI into `composeDir`.
// `dae update` calls this before `docker compose up -d --build` so the rebuilt
// image picks up the newly-installed CLI version (rather than the stale tarball
// from the last install).
// Whether the config points at the in-stack local Whisper container (the only
// transcription mode that needs the profile-gated `whisper` compose service activated;
// an external OpenAI-shaped endpoint has no container to start). Used by `dae update` to
// keep whisper up across rebuilds.
export function localWhisperEnabled(config: {
  transcribe?: { backend?: string | undefined; baseUrl?: string | undefined } | undefined;
}): boolean {
  const t = config.transcribe;
  return t?.backend === "openai-whisper" && (t.baseUrl ?? "").includes("whisper:8000");
}

export async function refreshComposeAssets(composeDir: string): Promise<boolean> {
  const ok = await materializeComposeFiles(composeDir);
  if (ok) await packCliInto(composeDir);
  return ok;
}

// Locate the active *deployment* docker-compose.yml for uninstall/update: the cwd
// (running from a checkout, where the user's .env lives) or the compose dir where
// `dae install` materialised it. NOT the package bundle — that's a template with
// no .env beside it, so returning it just yields a confusing interpolation error.
export async function findComposeFile(): Promise<string | null> {
  const candidates = [
    path.join(process.cwd(), "docker-compose.yml"),
    path.join(os.homedir(), ".daedalus", "compose", "docker-compose.yml"),
  ];
  for (const c of candidates) {
    if (await exists(c)) return c;
  }
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
