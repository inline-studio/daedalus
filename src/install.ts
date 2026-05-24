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
import { OneCLI } from "@onecli-sh/sdk";

// `dae install` — the one turnkey command. It is a thin orchestrator around
// docker compose: it makes sure a config exists, asks the *only* three questions
// that can't be inferred, writes the config + the compose `.env`, then runs
// `docker compose up -d` to bring up the whole stack (supervisor + scheduler,
// graphiti memory, and — if asked — a local whisper STT container).
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

  // OneCLI runs in the stack in local auth mode (open API on the daedalus network),
  // so we DON'T ask for a key — the supervisor creates its own agent and reads the
  // gateway config headlessly. daedalus still needs a non-empty ONECLI_API_KEY to
  // attempt the connection (local-mode onecli ignores its value), so generate one
  // and keep it stable across re-installs.
  const onecliKey = prevOnecliKey || randomBytes(24).toString("base64url");

  // 3. Persist config + runner secrets.
  const yamlEdits: Array<{ keyPath: string[]; value: unknown }> = [];
  // Memory: Graphiti (containerised temporal knowledge graph, reached by service name).
  // It runs its extraction LLM + embeddings on your spark endpoint, so it requires an
  // OpenAI-compatible provider to be configured. Without one it can't run — we leave
  // memory unconfigured and warn, rather than wiring a backend that won't start.
  if (useOpenai) {
    yamlEdits.push(
      { keyPath: ["memory", "backend"], value: "graphiti" },
      { keyPath: ["graphiti", "enabled"], value: true },
      { keyPath: ["graphiti", "url"], value: "http://graphiti:8000/mcp/" },
    );
  }
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
        "checkout, or copy docker-compose.yml + Dockerfile + Dockerfile.graphiti next to your config.",
    );
    return;
  }
  await packCliInto(composeDir);
  console.log(`✓ compose files → ${rel(composeDir)}`);

  // Graphiti memory runs only when an OpenAI-compatible (spark) endpoint is configured —
  // it runs its extraction LLM + embeddings there. Its store is local + portable, so we
  // bind-mount a host dir (GRAPHITI_DATA_PATH) that can be copied to a new host.
  const graphitiEnabled = useOpenai;
  const graphitiDataPath = path.join(os.homedir(), ".daedalus", "graphiti");
  const onecliCaPath = path.join(composeDir, "onecli-ca.pem");
  if (graphitiEnabled) await fs.mkdir(graphitiDataPath, { recursive: true });

  const composeEnv: Record<string, string> = {
    BRAIN_PATH: brainPath,
    DAEDALUS_CONFIG_DIR: configDir,
    UID: String(process.getuid?.() ?? 1000),
    DOCKER_GID: String(dockerGid()),
  };
  composeEnv.ONECLI_API_KEY = onecliKey;
  if (graphitiEnabled) {
    // Graphiti reaches spark THROUGH the OneCLI proxy (ONECLI_PROXY_URL is written after
    // OneCLI is up — see the two-phase bring-up below). The raw spark key is never stored.
    composeEnv.SPARK_URL = openaiBaseUrl;
    composeEnv.GRAPHITI_DATA_PATH = graphitiDataPath;
    composeEnv.ONECLI_CA_PATH = onecliCaPath;
  }
  // Persist the active compose profiles (MERGED) so EVERY compose command (install,
  // `dae update`, manual `docker compose`) keeps the SAME services up — not just this
  // run. Without this, `dae update` (compose up with no --profile) would drop them.
  composeEnv.COMPOSE_PROFILES = computeComposeProfiles({ whisper: wantWhisper, graphiti: graphitiEnabled });

  await upsertEnvFile(composeEnvPath, composeEnv);
  console.log(`✓ wrote compose env → ${rel(composeEnvPath)}`);

  // 5. Bring the stack up in TWO phases. Graphiti reaches spark THROUGH the OneCLI proxy,
  //    so it needs the proxy URL + OneCLI's MITM CA in .env BEFORE it starts — and those
  //    only exist once OneCLI is up. So: (a) start OneCLI, (b) register secrets + fetch
  //    Graphiti's proxy/CA, (c) build + start everything else.
  const composeUp = async (extra: string[]) => {
    const args = ["compose", "-f", composeFile, ...extra];
    console.log(`\n$ docker ${args.join(" ")}\n`);
    await execa("docker", args, { stdio: "inherit", cwd: composeDir });
  };

  // (a) OneCLI first (brings up onecli-db via depends_on). No --build: it's a pulled image.
  try {
    await composeUp(["up", "-d", "onecli"]);
  } catch (err) {
    console.error(`\nOneCLI bring-up failed: ${(err as Error).message}`);
    console.error("Fix the issue above, then re-run `dae install` (it's idempotent).");
    process.exitCode = 1;
    return;
  }
  if (!(await waitForOnecli("http://localhost:10254"))) {
    console.error("\nOneCLI didn't become reachable at http://localhost:10254 — aborting.");
    console.error("Check `docker compose logs onecli`, then re-run `dae install`.");
    process.exitCode = 1;
    return;
  }
  console.log("✓ OneCLI gateway is up");

  // (b) Register secrets in OneCLI now the gateway is up. Stored in OneCLI, never on
  //    disk — the agent sends the `onecli-managed` placeholder and the gateway swaps in
  //    the real value for the matching host. LLM keys: anthropic via the x-api-key
  //    header, openai-compatible via Authorization: Bearer.
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

  // Graphiti routes its spark calls through OneCLI too (no key on disk): fetch its proxy
  // URL (rewritten to the in-network `onecli` host) + the MITM CA, and write them where
  // the graphiti container reads them. The spark key registered above (by host) is what
  // OneCLI injects for Graphiti's requests.
  if (graphitiEnabled) {
    try {
      const proxyUrl = await provisionGraphitiProxy({
        baseUrl: "http://localhost:10254",
        apiKey: onecliKey,
        caPath: onecliCaPath,
      });
      if (proxyUrl) {
        await upsertEnvFile(composeEnvPath, { ONECLI_PROXY_URL: proxyUrl });
        console.log(`✓ wired Graphiti egress through OneCLI (CA → ${rel(onecliCaPath)})`);
      } else {
        console.error(
          "⚠ OneCLI returned no proxy URL — Graphiti can't reach spark. Check OneCLI, then re-run `dae install`.",
        );
      }
    } catch (err) {
      console.error(`⚠ Couldn't provision Graphiti's OneCLI proxy: ${(err as Error).message}`);
      console.error("  Graphiti may fail to reach spark until you re-run `dae install`.");
    }
  }

  // (c) Build + start the rest with the MERGED profiles. `--build` builds the daedalus
  //    and graphiti images. Idempotent — OneCLI stays as-is.
  try {
    await composeUp(["up", "-d", "--build", ...profileArgsFrom(composeEnv.COMPOSE_PROFILES)]);
  } catch (err) {
    console.error(`\nCompose bring-up failed: ${(err as Error).message}`);
    console.error("Fix the issue above, then re-run `dae install` (it's idempotent).");
    process.exitCode = 1;
    return;
  }

  console.log("\n✓ Stack is up. Containers:");
  console.log("    daedalus   — supervisor + scheduler");
  console.log("    dae-worker — warm agent worker (handles top-level turns)");
  if (graphitiEnabled) console.log("    graphiti   — knowledge-graph memory (FalkorDB)");
  console.log("    onecli     — credential gateway (+ postgres)");
  if (wantWhisper) console.log("    whisper    — local speech-to-text");
  if (!graphitiEnabled) {
    console.log(
      "\n⚠ Memory (Graphiti) is OFF: it needs an OpenAI-compatible (spark) endpoint for its\n" +
        "  extraction LLM + embeddings. Re-run `dae install` and enable an OpenAI-compatible\n" +
        "  provider to turn it on.",
    );
  }

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

// Merge the enabled service profiles into the single COMPOSE_PROFILES value. Compose
// treats it as ONE comma-joined list, so this must name EVERY service we want kept up
// across `up`/`update` — overwriting it (rather than merging) would silently drop
// whichever service isn't listed. Shared by install + update so they can't drift.
export function computeComposeProfiles(opts: { whisper: boolean; graphiti: boolean }): string {
  const profiles: string[] = [];
  if (opts.graphiti) profiles.push("graphiti");
  if (opts.whisper) profiles.push("whisper");
  return profiles.join(",");
}

// Turn a comma-joined COMPOSE_PROFILES value into repeated `--profile X` compose args.
export function profileArgsFrom(profiles: string): string[] {
  return profiles
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .flatMap((p) => ["--profile", p]);
}

// Poll OneCLI's REST API until it answers — it runs prisma migrations at boot, so it
// isn't ready the instant the container starts. Any HTTP response means it's up.
export async function waitForOnecli(baseUrl: string, timeoutMs = 90000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(baseUrl, { method: "GET" });
      if (r.ok || r.status === 404) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

// Fetch Graphiti's OneCLI proxy URL + MITM CA. ensureAgent("graphiti") creates the agent
// (idempotent) so getContainerConfig returns a scoped proxy token; we write the CA to
// caPath (mounted into the graphiti container) and return the proxy URL rewritten to the
// in-network `onecli` host (the bundle ships `host.docker.internal`, for host callers).
export async function provisionGraphitiProxy(opts: {
  baseUrl: string;
  apiKey: string;
  caPath: string;
}): Promise<string | null> {
  const onecli = new OneCLI({ url: opts.baseUrl, apiKey: opts.apiKey });
  try {
    await onecli.ensureAgent({ name: "graphiti", identifier: "graphiti" });
  } catch {
    // non-fatal: getContainerConfig will surface a real error if the agent is missing
  }
  const bundle = await onecli.getContainerConfig("graphiti");
  const raw =
    bundle.env.HTTPS_PROXY ?? bundle.env.HTTP_PROXY ?? bundle.env.https_proxy ?? bundle.env.http_proxy;
  if (!raw) return null;
  if (bundle.caCertificate) await fs.writeFile(opts.caPath, bundle.caCertificate, "utf8");
  return graphitiProxyForContainer(raw);
}

// The bundle's proxy URL points at `host.docker.internal` (for host callers). The
// graphiti container reaches OneCLI by its service name on the daedalus network, so swap
// the host to `onecli` while preserving the embedded agent token + port.
function graphitiProxyForContainer(rawProxyUrl: string): string {
  try {
    const u = new URL(rawProxyUrl);
    if (u.hostname === "host.docker.internal") u.hostname = "onecli";
    return u.toString();
  } catch {
    return rawProxyUrl.replace("host.docker.internal", "onecli");
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
const COMPOSE_FILES = [
  "docker-compose.yml",
  "Dockerfile",
  "Dockerfile.graphiti",
  "graphiti-entrypoint.sh",
  "graphiti.config.yaml",
];

// Restrict the docker build context to just the build inputs — never the compose
// .env (secrets), config, brain, or memory data that may sit nearby.
const DOCKERIGNORE = [
  "# Written by `dae install`. Keeps secrets/data out of the docker build context.",
  "*",
  "!Dockerfile",
  "!Dockerfile.graphiti",
  "!graphiti-entrypoint.sh",
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
