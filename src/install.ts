import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import prompts from "prompts";
import { loadConfig, configCandidates } from "./config/load.js";
import type { ArtemisConfig } from "./config/schema.js";
import { initUserConfig } from "./init.js";
import { confirm } from "./setup/base.js";
import { secretPrompt } from "./setup/secret-prompt.js";
import { editYamlFile, setIn, ensureMap } from "./setup/yaml-edit.js";
import { upsertEnvFile } from "./setup/env-file.js";
import { OneCliSecretsBackend } from "./secrets/store/onecli-backend.js";
import { hashPassword } from "./channels/web-auth.js";
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

// The deployment intent — what `dae install` gathers interactively and `dae update` infers
// from the existing config + OneCLI. A `*Key` left undefined means "don't (re-)register it":
// either it's already in OneCLI, or — for an enabled provider that's genuinely missing one —
// applyDeployment prompts for just that key. Lets `dae update` re-apply everything (config
// migrations, provisioning, bring-up) with no prompts in the happy path.
export interface InstallAnswers {
  useAnthropic: boolean;
  anthropicKey?: string;
  useOpenai: boolean;
  openaiBaseUrl?: string;
  openaiKey?: string;
  wantWhisper: boolean;
  telegramToken?: string;
  braveKey?: string;
}

// `dae install` resolves the deployment intent in one of three modes (see installAnswerMode):
//   • apply  — `opts.answers` supplied (by `dae update`): apply that intent, no prompts.
//   • reuse  — a re-run of an existing install WITHOUT `--fresh`: infer the intent from the
//              current config (same as `dae update`) and re-apply it — no re-asking. The
//              bring-up still prompts for a genuinely-missing *required* key. One-and-done.
//   • ask    — `--fresh`, or a genuine first install (no prior compose .env): ask the
//              questions (prior answers, if any, pre-fill the defaults).
export async function runInstall(
  opts: { config?: string; fresh?: boolean; answers?: InstallAnswers } = {},
): Promise<void> {
  const configFlag = opts.config;
  const fresh = Boolean(opts.fresh);
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
  // The runner's .env.local holds locally-verified secrets (telegram token, web-login creds) —
  // read it so re-runs preserve them ("leave blank to keep").
  const envLocalPrev = await readEnvFile(envLocalPath);
  // Remote memory access: a previously-minted bearer token (kept stable across re-runs) and
  // the prior remote decision/bind from the config (re-applied by `dae update` without asking).
  const prevRemoteToken = prev.GRAPHITI_REMOTE_TOKEN ?? "";
  const priorRemote = config.graphiti?.remote;

  // 2. Resolve the deployment intent — supplied (dae update, no prompts) or asked. Keys are
  // stored in OneCLI (never on disk); a blank/undefined key means "keep what's already in
  // OneCLI" (the bring-up below prompts only for an enabled provider that's genuinely missing
  // one). Interactive defaults reuse your previous setup unless --fresh.
  let useAnthropic = false;
  let anthropicKey = "";
  let useOpenai = false;
  let openaiKey = "";
  let openaiBaseUrl = "";
  let wantWhisper = false;
  let tgToken = "";
  let braveKey = "";
  // Default to the existing remote-memory state; the offer below (which runs on `dae install`
  // AND `dae update`) may flip it on. Carried through every mode so an update preserves it.
  let wantRemoteMemory = Boolean(priorRemote?.enabled);

  // A prior install wrote the compose .env; its presence means "already set up". Decide how
  // to resolve the intent: apply supplied answers (update), reuse the existing setup (re-run
  // without --fresh), or ask (fresh / genuine first install).
  const priorInstall = Object.keys(prev).length > 0;
  const mode = installAnswerMode({ hasAnswers: Boolean(opts.answers), fresh, priorInstall });
  const answers = opts.answers ?? (mode === "reuse" ? resolveAnswersInferred(config) : undefined);

  // Graphiti's extraction + embeddings model names (and the embed dimension, which MUST match
  // the embeddings model). Defaults are conventional OpenAI ids that work out of the box; the
  // interactive branch below lets the user point them at whatever exists on their endpoint, and
  // a prior install's values (if any) pre-fill so a re-run / `dae update` keeps them.
  let graphitiLlmModel = prev.GRAPHITI_LLM_MODEL ?? "gpt-4o-mini";
  let graphitiEmbedModel = prev.GRAPHITI_EMBED_MODEL ?? "text-embedding-3-small";
  let graphitiEmbedDim = prev.GRAPHITI_EMBED_DIM ?? "1536";

  if (answers) {
    const a = answers;
    useAnthropic = a.useAnthropic;
    anthropicKey = a.anthropicKey ?? "";
    useOpenai = a.useOpenai;
    openaiBaseUrl = a.openaiBaseUrl ?? config.providers?.openai?.baseUrl ?? "";
    openaiKey = a.openaiKey ?? "";
    wantWhisper = a.wantWhisper;
    tgToken = a.telegramToken ?? "";
    braveKey = a.braveKey ?? "";
    if (mode === "reuse") {
      console.log(
        "\nReusing your existing configuration (stored keys kept; only a genuinely-missing\n" +
          "required key would be asked for). Pass `--fresh` to reconfigure from scratch.",
      );
    }
  } else {
    console.log("\nDaedalus runs entirely in docker containers. A few questions:\n");

    useAnthropic = await confirm(
      "Will any agent use Anthropic (Claude) directly at api.anthropic.com?",
      !fresh && Boolean(config.providers?.anthropic),
    );
    if (useAnthropic) {
      const keep = !fresh && Boolean(config.providers?.anthropic);
      anthropicKey = ((await secretPrompt({
        message: keep ? "Anthropic API key (leave blank to keep existing):" : "Anthropic API key (sk-ant-…):",
      })) ?? "").trim();
    }

    useOpenai = await confirm(
      "Will any agent use an OpenAI-compatible endpoint (OpenAI, LiteLLM, vLLM, Ollama …)?",
      !fresh && Boolean(config.providers?.openai?.baseUrl),
    );
    if (useOpenai) {
      const defaultBase = config.providers?.openai?.baseUrl ?? "https://api.openai.com/v1";
      openaiBaseUrl =
        (await textPrompt(`Base URL for that endpoint (must include /v1) [${defaultBase}]:`)) || defaultBase;
      const keep = !fresh && Boolean(config.providers?.openai?.baseUrl);
      openaiKey = ((await secretPrompt({
        message: keep ? "API key / token (leave blank to keep existing):" : "API key / token for that endpoint:",
      })) ?? "").trim();

      // Memory (Graphiti) extraction + embeddings models. These must EXIST on the endpoint
      // above — the shipped defaults are conventional OpenAI ids, not magic aliases. The embed
      // dimension must match the embeddings model (1536 for text-embedding-3-small, 768 for a
      // local nomic-embed-text, etc.). Defaults pre-fill from a prior install where present.
      console.log("\n  Memory (Graphiti) runs an extraction LLM + an embeddings model on that endpoint.");
      graphitiLlmModel =
        (await textPrompt(`  Extraction model name (must exist on the endpoint) [${graphitiLlmModel}]:`)) ||
        graphitiLlmModel;
      graphitiEmbedModel =
        (await textPrompt(`  Embeddings model name [${graphitiEmbedModel}]:`)) || graphitiEmbedModel;
      graphitiEmbedDim =
        (await textPrompt(`  Embeddings dimension (must match that model) [${graphitiEmbedDim}]:`)) ||
        graphitiEmbedDim;
    }

    wantWhisper = await confirm(
      "Run a local Whisper container for voice-note transcription?",
      !fresh && localWhisperEnabled(config),
    );

    const tgRaw =
      ((await secretPrompt({
        message: "Telegram bot token from @BotFather (leave blank to skip / keep existing):",
      })) ?? "").trim();
    if (tgRaw && !TELEGRAM_TOKEN_RE.test(tgRaw)) {
      console.log("  ⚠ that doesn't look like a Telegram bot token — skipping Telegram setup.");
    } else {
      tgToken = tgRaw;
    }

    braveKey =
      ((await secretPrompt({
        message: "Brave Search API key for web_search (leave blank to skip / keep existing):",
      })) ?? "").trim();
  }

  const enableTelegram = Boolean(tgToken) && TELEGRAM_TOKEN_RE.test(tgToken);

  // Web UI login (username/password). Reuse existing creds from .env.local on every run. Offer
  // to set one up whenever it isn't configured yet AND we have an interactive terminal — this
  // fires on `dae install` AND `dae update` (both run with a TTY), so an update lands the
  // feature too without a separate command. A previous decline is remembered
  // (WEB_LOGIN_OPT_OUT) so we don't re-ask every run; `--fresh` re-asks regardless; a
  // non-interactive invocation (no TTY, e.g. cron) just skips. The raw password is never
  // stored: only an scrypt hash plus a stable signing secret.
  let webUsername = envLocalPrev.WEB_USERNAME ?? "";
  let webPasswordHash = envLocalPrev.WEB_PASSWORD_HASH ?? "";
  let webSessionSecret = envLocalPrev.WEB_SESSION_SECRET ?? "";
  let webOptOut = false;
  const loginConfigured = Boolean(webUsername && webPasswordHash);
  const declinedBefore = envLocalPrev.WEB_LOGIN_OPT_OUT === "1";
  if (process.stdin.isTTY && !loginConfigured && (fresh || !declinedBefore)) {
    const wantLogin = await confirm(
      "Add the web chat UI's own username/password login (so your reverse proxy only needs to add TLS, not basic_auth)?",
      true,
    );
    if (wantLogin) {
      const defUser = webUsername || "admin";
      webUsername = (await textPrompt(`Web login username [${defUser}]:`)) || defUser;
      const pw = ((await secretPrompt({ message: "Web login password:" })) ?? "").trim();
      if (pw) {
        webPasswordHash = hashPassword(pw);
      } else {
        webUsername = "";
        console.log("  (no password entered — skipping web login; front the UI with your own proxy auth)");
      }
    } else {
      webUsername = "";
      webOptOut = true; // remember the decline so future install/update runs don't re-ask
    }
  }
  const webLogin = Boolean(webUsername && webPasswordHash);
  if (webLogin && !webSessionSecret) webSessionSecret = randomBytes(32).toString("base64");

  // Remote memory access offer. Like the web-login offer above, this runs on `dae install` AND
  // `dae update` (both have a TTY) so an existing install can turn it on without --fresh — which
  // is why it lives HERE, outside the answers/interactive split (the answers branch never
  // prompts). Only meaningful when Graphiti will run (useOpenai). If it's already enabled we keep
  // it (no re-ask). A remembered decline (GRAPHITI_REMOTE_OPT_OUT) stops us nagging every update;
  // `--fresh` re-asks regardless; a non-interactive run (no TTY) just keeps the prior state.
  // Default NO — this publishes a port, so opting in must be deliberate.
  let remoteOptOut = false;
  const remoteDeclinedBefore = prev.GRAPHITI_REMOTE_OPT_OUT === "1";
  if (useOpenai && process.stdin.isTTY && !wantRemoteMemory && (fresh || !remoteDeclinedBefore)) {
    wantRemoteMemory = await confirm(
      "Allow the memory server (Graphiti) to be reached REMOTELY over MCP, behind your own " +
        "reverse proxy? (publishes its port + generates a bearer token; you add TLS/auth in the proxy)",
      false,
    );
    if (!wantRemoteMemory) remoteOptOut = true; // remember the decline so future runs don't re-ask
  }

  // OneCLI runs in the stack in local auth mode (it ignores the key's value), but daedalus
  // still needs a non-empty ONECLI_API_KEY to attempt the connection. Keep it stable.
  const onecliKey = prevOnecliKey || randomBytes(24).toString("base64url");

  // Remote memory access (opt-in). Only meaningful when Graphiti runs (needs an
  // OpenAI-compatible endpoint — see graphitiEnabled below). When on we publish Graphiti's
  // MCP port and mint a bearer token for the user's reverse proxy to enforce (Graphiti has no
  // auth of its own). The token is kept STABLE across re-runs (reuse the prior one if present)
  // so an existing proxy config + client keep working after `dae update`.
  const remoteEnabled = useOpenai && wantRemoteMemory;
  const remoteHost = priorRemote?.host ?? "127.0.0.1";
  const remotePort = priorRemote?.port ?? 8000;
  const remoteToken = remoteEnabled ? prevRemoteToken || randomBytes(32).toString("base64url") : prevRemoteToken;

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
      // Persist the remote-access decision so `dae update` re-applies it (incl. the published
      // port overlay) without re-asking. The bearer token stays in the compose .env, not here.
      { keyPath: ["graphiti", "remote", "enabled"], value: remoteEnabled },
      { keyPath: ["graphiti", "remote", "host"], value: remoteHost },
      { keyPath: ["graphiti", "remote", "port"], value: remotePort },
    );
  }
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
  if (useOpenai && openaiBaseUrl) {
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
  // Channels for an all-container deployment: the Web chat UI is ON by default (served by
  // the supervisor on :8765, front it with your own reverse proxy — printed at the end).
  // The CLI channel is disabled: it needs an interactive stdin the supervisor container
  // doesn't have, and would otherwise EOF-loop the process. Talk to agents via the Web UI
  // (and/or Telegram). The web channel is the same agent + Graphiti memory as any channel.
  yamlEdits.push(
    { keyPath: ["channels", "cli", "enabled"], value: false },
    { keyPath: ["channels", "web", "enabled"], value: true },
    { keyPath: ["channels", "web", "defaultAgent"], value: defaultAgent },
    { keyPath: ["channels", "web", "port"], value: 8765 },
  );
  // Web login: store the creds in .env.local and reference them from config via ${…} (the
  // raw password is never written — only the scrypt hash). With all three set, the web channel
  // serves its own /login page + cookie auth and ignores the bearer token.
  if (webLogin) {
    runnerEnv.WEB_USERNAME = webUsername;
    runnerEnv.WEB_PASSWORD_HASH = webPasswordHash;
    runnerEnv.WEB_SESSION_SECRET = webSessionSecret;
    yamlEdits.push(
      { keyPath: ["channels", "web", "username"], value: "${WEB_USERNAME}" },
      { keyPath: ["channels", "web", "passwordHash"], value: "${WEB_PASSWORD_HASH}" },
      { keyPath: ["channels", "web", "sessionSecret"], value: "${WEB_SESSION_SECRET}" },
    );
  } else if (webOptOut) {
    // Persist the "no thanks" so `dae install`/`dae update` stop offering it (until --fresh).
    runnerEnv.WEB_LOGIN_OPT_OUT = "1";
  }

  await editYamlFile(configPath, (doc) => {
    for (const e of yamlEdits) setIn(doc, e.keyPath, e.value);
    // Materialise the anthropic provider block (no leaf value — the key lives in
    // OneCLI) so it's visible/enabled, without clobbering an existing one.
    if (useAnthropic) ensureMap(doc, ["providers", "anthropic"]);
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

  // Timezone for the long-lived containers AND every agent container they spawn. Both the
  // scheduler (croner evaluates cron in the system zone) and the injected "# Now" context
  // read the container's TZ, so a single value keeps fired schedules and displayed local
  // time in agreement — without it the containers default to UTC. Default to the host's
  // detected zone; ask in interactive setup, and in reuse mode (a normal `dae update`) only
  // when it isn't pinned yet, so an update retrofits an existing install exactly once.
  const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  let timezone = prev.TZ || "";
  if (mode === "interactive" || (mode === "reuse" && !timezone)) {
    timezone =
      (await textPrompt(
        `Timezone for scheduling + timestamps (IANA name, e.g. Europe/London) [${timezone || detectedTz}]:`,
      )) ||
      timezone ||
      detectedTz;
  }
  if (!timezone) timezone = detectedTz;

  // Cross-agent shared workspace, wired as a HOST BIND (not a docker volume) so its
  // contents are browsable from the host filesystem. Stable across re-runs: reuse the
  // prior value if set, else default to <configDir>/shared. dae-runtime-init chowns it
  // to ${UID} on bring-up so the non-root container user can write to it; we create it
  // here too so the bind source exists before the first `docker compose up`.
  const sharedPath = prev.SHARED_PATH || path.join(configDir, "shared");
  await fs.mkdir(sharedPath, { recursive: true });

  const composeEnv: Record<string, string> = {
    BRAIN_PATH: brainPath,
    DAEDALUS_CONFIG_DIR: configDir,
    SHARED_PATH: sharedPath,
    UID: String(process.getuid?.() ?? 1000),
    DOCKER_GID: String(dockerGid()),
    TZ: timezone,
  };
  composeEnv.ONECLI_API_KEY = onecliKey;
  // Stable at-rest encryption key for OneCLI's secret store. OneCLI otherwise auto-generates
  // one into its EPHEMERAL /app/data, so a container recreate or image update silently rotates
  // it and makes every stored secret undecryptable (the casa outage). Pin it: reuse the one
  // already in .env; else LIFT the existing onecli container's current key so already-stored
  // secrets keep decrypting across this migration; else mint a fresh one. Reusing-from-.env on
  // every re-run is what lets us stay on a moving image tag without ever losing secrets.
  let secretEncKey = prev.SECRET_ENCRYPTION_KEY || process.env.SECRET_ENCRYPTION_KEY || "";
  if (!secretEncKey) {
    const captured = await captureOnecliEncryptionKey(composeFile, composeDir);
    if (captured) {
      secretEncKey = captured;
      console.log("✓ preserved OneCLI's existing secret-encryption key (stored secrets stay valid)");
    } else {
      secretEncKey = randomBytes(32).toString("base64");
    }
  }
  composeEnv.SECRET_ENCRYPTION_KEY = secretEncKey;
  if (graphitiEnabled) {
    // Graphiti reaches the endpoint THROUGH the OneCLI proxy (ONECLI_PROXY_URL is written after
    // OneCLI is up — see the two-phase bring-up below). The raw endpoint key is never stored.
    // Write the model names explicitly (not just the URL): the shipped defaults are conventional
    // OpenAI ids, so an endpoint using other names needs these persisted in the compose .env.
    composeEnv.OPENAI_BASE_URL = openaiBaseUrl;
    composeEnv.GRAPHITI_LLM_MODEL = graphitiLlmModel;
    composeEnv.GRAPHITI_EMBED_MODEL = graphitiEmbedModel;
    composeEnv.GRAPHITI_EMBED_DIM = graphitiEmbedDim;
    composeEnv.GRAPHITI_DATA_PATH = graphitiDataPath;
    composeEnv.ONECLI_CA_PATH = onecliCaPath;
  }
  if (remoteEnabled) {
    // Consumed by docker-compose.remote.yml (the published-port overlay). The token isn't read
    // by compose — it's persisted here so it stays stable across re-runs and we can re-print it.
    composeEnv.GRAPHITI_REMOTE_BIND = remoteHost;
    composeEnv.GRAPHITI_REMOTE_PORT = String(remotePort);
    composeEnv.GRAPHITI_REMOTE_TOKEN = remoteToken;
  } else if (remoteOptOut) {
    // Persist the "no thanks" so `dae install`/`dae update` stop offering it (until --fresh).
    composeEnv.GRAPHITI_REMOTE_OPT_OUT = "1";
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
  // Run a compose command under a spinner with its (noisy) pull/build output captured rather
  // than streamed. execa's `all` collects stdout+stderr so a caller can surface it on failure.
  // When remote memory is enabled, merge the published-port overlay onto every bring-up so the
  // graphiti container is (re)created WITH its host port. `-f` order matters: base first, overlay
  // second (compose deep-merges later files on top). All other compose calls in this flow target
  // single services / queries and don't need the overlay, so they keep the base file only.
  const remoteOverride = path.join(composeDir, "docker-compose.remote.yml");
  const composeFileArgs = remoteEnabled ? ["-f", composeFile, "-f", remoteOverride] : ["-f", composeFile];
  const composeUp = async (label: string, extra: string[]) =>
    withSpinner(label, () => execa("docker", ["compose", ...composeFileArgs, ...extra], { cwd: composeDir, all: true }));

  // (a) OneCLI first (brings up onecli-db via depends_on). No --build: it's a pulled image.
  try {
    await composeUp("Starting the credential gateway", ["up", "-d", "onecli"]);
  } catch (err) {
    dumpComposeError(err);
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

  // (b) Ensure provider/search secrets are in OneCLI (stored there, never on disk). For each
  //    enabled provider: register the key if one was provided this run; else SKIP if it's
  //    already in OneCLI (so `dae update` doesn't re-ask); else (enabled but genuinely
  //    missing) prompt for just that one key. Keys: anthropic via x-api-key, openai via Bearer.
  const onecli = new OneCliSecretsBackend({ baseUrl: "http://localhost:10254", token: onecliKey });
  let presentSecrets = new Set<string>();
  try {
    presentSecrets = new Set((await onecli.list()).map((s) => s.name));
  } catch (err) {
    console.error(`⚠ couldn't list OneCLI secrets: ${(err as Error).message}`);
  }
  const secretSpecs: Array<{
    name: string;
    key: string;
    urlPattern: string;
    headerName: string;
    valueFormat: string;
    label: string;
    optional?: boolean;
  }> = [];
  if (useOpenai) {
    secretSpecs.push({
      name: "OPENAI_API_KEY",
      key: openaiKey,
      urlPattern: hostnameOf(openaiBaseUrl),
      headerName: "Authorization",
      valueFormat: "Bearer {value}",
      label: `API key for ${hostnameOf(openaiBaseUrl)}`,
    });
  }
  if (useAnthropic) {
    secretSpecs.push({
      name: "ANTHROPIC_API_KEY",
      key: anthropicKey,
      urlPattern: "api.anthropic.com",
      headerName: "x-api-key",
      valueFormat: "{value}",
      label: "Anthropic API key (sk-ant-…)",
    });
  }
  secretSpecs.push({
    name: "BRAVE_API_KEY",
    key: braveKey,
    urlPattern: "api.search.brave.com",
    headerName: "X-Subscription-Token",
    valueFormat: "{value}",
    label: "Brave Search API key",
    optional: true,
  });
  for (const s of secretSpecs) {
    let value = s.key;
    if (!value) {
      if (presentSecrets.has(s.name)) continue; // already stored — keep it
      if (s.optional) continue; // not provided, not present, optional → leave it off
      // Required provider with no key anywhere — ask for just this one (keeps update one-and-done).
      value = ((await secretPrompt({ message: `${s.label} (required; leave blank to skip):` })) ?? "").trim();
      if (!value) {
        console.error(`⚠ ${s.name} not set — add later: dae secret save ${s.name} -u ${s.urlPattern} -H ${s.headerName}`);
        continue;
      }
    }
    try {
      await onecli.save(s.name, value, {
        urlPattern: s.urlPattern,
        injectionConfig: { headerName: s.headerName, valueFormat: s.valueFormat },
      });
      console.log(`✓ registered ${s.name} in OneCLI (→ ${s.urlPattern})`);
    } catch (err) {
      console.error(`⚠ Couldn't register ${s.name} in OneCLI: ${(err as Error).message}`);
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

  // (c) Build + start the rest. The active profiles come from COMPOSE_PROFILES in the
  //    compose .env (written above + read automatically), so `up` brings up the graphiti
  //    profile without a `--profile` flag. `--build` builds the daedalus + graphiti images.
  //    Idempotent — OneCLI stays as-is.
  //
  //    First, stop the prior `daedalus` web container so its 127.0.0.1:8765 publish is
  //    released BEFORE the recreate tries to bind it again. The supervisor is the only
  //    service that publishes a host port (the web UI); on a re-run, docker's lazy teardown
  //    of a loopback publish (or a still-running prior container) otherwise makes the new
  //    container fail with "address already in use". Best-effort — a no-op on first install.
  try {
    await composeUp("Preparing the web service", ["stop", "daedalus"]);
  } catch {
    // nothing to stop (first install / already down) — fine (no output dump).
  }

  //    `--remove-orphans` clears containers for services dropped from the compose file
  //    (e.g. the retired mempalace container) so re-runs converge on the current stack.
  try {
    await composeUp("Building & starting Daedalus (first run can take a few minutes)", [
      "up",
      "-d",
      "--build",
      "--remove-orphans",
    ]);
  } catch (err) {
    dumpComposeError(err);
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

  // Web UI is on by default, published to loopback only. Front it with your own reverse proxy
  // for TLS. Auth lives in the app when the built-in login is configured; otherwise put it in
  // the proxy (basic_auth). Print the matching Caddy example.
  console.log("\n── Web chat UI ──────────────────────────────────────────────");
  if (webLogin) {
    console.log(`Served on http://127.0.0.1:8765 (loopback). It has its OWN login (user: ${webUsername}),`);
    console.log("so the proxy only needs to add TLS — no basic_auth. Example Caddy (replace the");
    console.log("hostname; the SSE reply stream needs flush_interval -1):\n");
    console.log("    chat.example.com {");
    console.log("        reverse_proxy 127.0.0.1:8765 {");
    console.log("            flush_interval -1");
    console.log("        }");
    console.log("    }\n");
    console.log("  Change the login later with: dae web hash-password  (update WEB_PASSWORD_HASH in");
    console.log(`  ${rel(envLocalPath)}), or re-run \`dae install --fresh\`.`);
  } else {
    console.log("Served on http://127.0.0.1:8765 (loopback). No built-in login is configured, so");
    console.log("front it with your own reverse proxy for TLS + auth. Example Caddy (replace the");
    console.log("hostname; the SSE reply stream needs flush_interval -1; `caddy hash-password`");
    console.log("makes the basic_auth hash):\n");
    console.log("    chat.example.com {");
    console.log("        reverse_proxy 127.0.0.1:8765 {");
    console.log("            flush_interval -1");
    console.log("        }");
    console.log("        basic_auth {   # the first field is a USERNAME you choose, not a keyword");
    console.log("            <username> <bcrypt-hash>   # hash: run `caddy hash-password`");
    console.log("        }");
    console.log("    }\n");
    console.log("  (Prefer an in-app login? Re-run `dae install` and enable the web login.)");
  }
  console.log("  If your proxy runs on another host/container, set WEB_BIND=0.0.0.0 in");
  console.log(`  ${rel(composeEnvPath)} so it can reach the port.`);
  console.log("─────────────────────────────────────────────────────────────");

  // Remote memory (MCP). Printed only when the user opted in. Graphiti has NO auth of its own,
  // so the bearer token MUST be enforced by the reverse proxy. We lead with the CONTAINERISED
  // proxy recipe (proxy → `graphiti:8000` over the daedalus network) because that's how most
  // docker deployments run their proxy — and a containerised proxy pointed at the published
  // 127.0.0.1 port hits ITS OWN loopback, not the host, which 502s. The host-proxy variant
  // (→ the published port) is given as the alternative.
  if (remoteEnabled) {
    // Compose names the network <project>_daedalus; the project defaults to the compose dir's
    // basename (we run compose with cwd = composeDir). Printed as a starting point — the user
    // confirms it with `docker network ls`.
    const daedalusNetwork = `${path.basename(composeDir)}_daedalus`;
    console.log("\n── Remote memory (MCP) ──────────────────────────────────────");
    console.log(`Graphiti's MCP port is published on http://${remoteHost}:${remotePort} (loopback`);
    console.log("by default). ⚠ Graphiti has NO built-in auth — anything that can reach it can");
    console.log("read/write your whole memory graph. NEVER expose it directly; front it with a");
    console.log("reverse proxy that enforces the bearer token below (TLS + auth).\n");
    console.log("Bearer token (store it safely — re-printed on re-run, rotate by clearing");
    console.log(`GRAPHITI_REMOTE_TOKEN in ${rel(composeEnvPath)} and re-running \`dae install\`):\n`);
    console.log(`    ${remoteToken}\n`);
    console.log("Most proxies for this stack run as a CONTAINER. Put yours on Daedalus's docker");
    console.log("network and proxy to the `graphiti` service by name — then the published host");
    console.log("port isn't even needed (a containerised proxy aimed at 127.0.0.1 hits its own");
    console.log("loopback, not the host → 502). Example Caddy (replace the hostname):\n");
    console.log("    memory.example.com {");
    console.log(`        @unauthorized not header Authorization "Bearer ${remoteToken}"`);
    console.log('        handle @unauthorized {');
    console.log('            respond "Unauthorized" 401');
    console.log("        }");
    console.log("        handle {");
    console.log("            reverse_proxy graphiti:8000 {");
    console.log("                flush_interval -1                 # MCP reply stream needs this");
    console.log("                header_up Host {upstream_hostport} # avoids Graphiti host-check");
    console.log("            }");
    console.log("        }");
    console.log("    }\n");
    console.log("…and attach the proxy's container to Daedalus's network (confirm the name with");
    console.log("`docker network ls | grep daedalus`):\n");
    console.log("    networks:");
    console.log("      daedalus:");
    console.log("        external: true");
    console.log(`        name: ${daedalusNetwork}\n`);
    console.log("If instead your proxy runs ON THE HOST, skip the network block and point it at");
    console.log(`the published port: reverse_proxy 127.0.0.1:${remotePort}`);
    if (remoteHost === "0.0.0.0") {
      console.log("  (Bound to 0.0.0.0 — reachable beyond loopback. Make sure ONLY your proxy can");
      console.log(`  reach ${remotePort}, e.g. firewall it; the token is enforced at the proxy.)`);
    } else {
      console.log("  (For a proxy on ANOTHER host, set graphiti.remote.host: 0.0.0.0 and re-run.)");
    }
    console.log("\nPoint a remote MCP client at it (streamable-HTTP transport):\n");
    console.log("    URL:    https://memory.example.com/mcp/");
    console.log(`    Header: Authorization: Bearer ${remoteToken}\n`);
    console.log("  Turn this off later: set graphiti.remote.enabled: false and re-run `dae install`.");
    console.log("─────────────────────────────────────────────────────────────");
  }

  if (!graphitiEnabled) {
    console.log(
      "\n⚠ Memory (Graphiti) is OFF: it needs an OpenAI-compatible endpoint for its\n" +
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

// Decide how `dae install`/`dae update` resolves the deployment intent:
//   • "apply"       — answers were supplied (by `dae update`): apply them, no prompts.
//   • "reuse"       — re-run of an existing install without --fresh: infer from the config and
//                     re-apply (no re-asking; bring-up still prompts for a missing required key).
//   • "interactive" — --fresh, or a genuine first install (no prior compose .env): ask.
// Pure (no I/O) so it's unit-testable; runInstall passes priorInstall = "compose .env exists".
export function installAnswerMode(opts: {
  hasAnswers: boolean;
  fresh: boolean;
  priorInstall: boolean;
}): "apply" | "reuse" | "interactive" {
  if (opts.hasAnswers) return "apply";
  if (!opts.fresh && opts.priorInstall) return "reuse";
  return "interactive";
}

// Infer the deployment intent from an existing config — used by `dae update` (and a non-fresh
// `dae install` re-run) so it can re-apply everything (config migrations, provisioning,
// bring-up) without prompts. Keys are left undefined: they're already in OneCLI, and runInstall
// skips re-registering present ones (prompting only for an enabled provider whose key is
// genuinely missing).
export function resolveAnswersInferred(config: ArtemisConfig): InstallAnswers {
  return {
    useAnthropic: Boolean(config.providers?.anthropic),
    useOpenai: Boolean(config.providers?.openai?.baseUrl),
    ...(config.providers?.openai?.baseUrl ? { openaiBaseUrl: config.providers.openai.baseUrl } : {}),
    wantWhisper: localWhisperEnabled(config),
  };
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

// Read OneCLI's auto-generated secret-encryption key from an EXISTING onecli container (running
// or stopped) so migrating to a pinned SECRET_ENCRYPTION_KEY doesn't orphan already-stored
// secrets. OneCLI writes it to /app/data/secret-encryption-key in its ephemeral layer; we lift
// it via `docker cp` BEFORE the container is recreated with the env-provided key. Returns the
// trimmed key, or undefined when there's no prior container / key file (a genuine fresh install,
// or a non-OSS edition that uses KMS). Best-effort: any failure falls back to minting a new key.
async function captureOnecliEncryptionKey(
  composeFile: string,
  composeDir: string,
): Promise<string | undefined> {
  let cid = "";
  try {
    const r = await execa("docker", ["compose", "-f", composeFile, "ps", "-aq", "onecli"], {
      cwd: composeDir,
    });
    cid = r.stdout.trim().split(/\r?\n/)[0] ?? "";
  } catch {
    return undefined; // docker/compose not available or no project yet
  }
  if (!cid) return undefined;
  const tmp = path.join(os.tmpdir(), `onecli-enc-${process.pid}-${Date.now()}`);
  try {
    // `docker cp <container>:<file> <hostfile>` works on a stopped container too (no exec/start).
    await execa("docker", ["cp", `${cid}:/app/data/secret-encryption-key`, tmp]);
    const v = (await fs.readFile(tmp, "utf8")).trim();
    return v || undefined;
  } catch {
    return undefined; // no key file (fresh) — caller mints a fresh key
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

// Ensure a config file exists, bootstrapping one at ~/.daedalus/config.yaml if
// the user agrees. Returns the resolved config path, or null if cancelled.
async function ensureConfig(configFlag?: string): Promise<string | null> {
  // IMP-03: look in exactly the same places loadConfig checks (the lists had drifted).
  const candidates = [configFlag, ...configCandidates()].filter((p): p is string => Boolean(p));

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
// copies these into the compose dir so a global install is self-contained. EVERY name here
// MUST also be present in the published tarball — either explicitly in package.json's
// `files` whitelist, or under a directory entry there (e.g. "runtime/" covers
// "runtime/agent-turn.sh"). smoke-package-files guards exactly that invariant — without
// it `dae install` materialises a compose dir that references a missing build input,
// docker build fails on the COPY line, and the user is stuck (graphiti's Dockerfile
// hit this once; the runtime/ shim scripts hit it again when PR #75 landed).
//
// Paths may include subdirectories — materializeComposeFiles creates the parent dir
// before copying. .dockerignore is auto-derived from this list so the docker build
// context allows exactly these inputs (plus the packed tarball glob).
export const COMPOSE_FILES = [
  "docker-compose.yml",
  // Optional overlay (merged with `-f`) that publishes the Graphiti MCP port to a host port
  // for remote access. Always materialised so it's there when graphiti.remote.enabled flips
  // on; only actually passed to `docker compose` when remote memory is enabled.
  "docker-compose.remote.yml",
  "Dockerfile",
  "Dockerfile.graphiti",
  "graphiti-entrypoint.sh",
  "graphiti.config.yaml",
  // Per-agent container shim sourced from the Dockerfile (PR #75). Real files,
  // not printf'd inline, so they're testable on the host (smoke-agent-shim).
  "runtime/agent-turn.sh",
  "runtime/setup-ssh.sh",
];

// Restrict the docker build context to just the build inputs — never the compose
// .env (secrets), config, brain, or memory data that may sit nearby.
//
// Derived from COMPOSE_FILES so a new entry there is automatically un-ignored.
// Two extras: the packed CLI tarball (matches `daedalus-*.tgz` via glob — it's
// produced by `npm pack` into this dir at install time), and any parent dirs
// of nested COMPOSE_FILES entries (docker build needs to traverse into them).
const DOCKERIGNORE = [
  "# Written by `dae install`. Keeps secrets/data out of the docker build context.",
  "*",
  ...uniqueDockerignoreAllows(COMPOSE_FILES),
  "!daedalus-*.tgz",
  "",
].join("\n");

// For each path, emit an allow for the file PLUS every parent directory along
// the way, so `*` doesn't kill the directory before docker can descend into it.
function uniqueDockerignoreAllows(paths: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/");
    for (let i = 1; i <= parts.length; i++) {
      out.add("!" + parts.slice(0, i).join("/"));
    }
  }
  return [...out];
}

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
    const to = path.join(targetDir, name);
    // Nested entries (e.g. "runtime/agent-turn.sh") need their parent dir
    // created before copyFile will work.
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(from, to);
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

// Run an async task under a one-line spinner, keeping its (noisy docker pull/build) output
// hidden. On a non-TTY (CI/piped) it just prints the label and runs. The caller surfaces the
// captured output on failure via dumpComposeError. Always restores the cursor.
async function withSpinner<T>(label: string, fn: () => Promise<T>): Promise<T> {
  if (!process.stdout.isTTY) {
    process.stdout.write(`${label}…\n`);
    return fn();
  }
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  process.stdout.write("[?25l"); // hide cursor
  const timer = setInterval(() => {
    process.stdout.write(`\r${frames[i++ % frames.length]} ${label}…`);
  }, 80);
  const finish = (mark: string) => {
    clearInterval(timer);
    process.stdout.write(`\r${mark} ${label}[K\n`); // [K clears the rest of the line
    process.stdout.write("[?25h"); // restore cursor
  };
  try {
    const r = await fn();
    finish("✓");
    return r;
  } catch (e) {
    finish("✗");
    throw e;
  }
}

// Surface a failed compose command's captured output (execa merges stdout+stderr into `all`)
// so a hidden-behind-the-spinner failure is still debuggable.
function dumpComposeError(err: unknown): void {
  const e = err as { all?: string; stdout?: string; stderr?: string };
  const out = e.all ?? [e.stdout, e.stderr].filter(Boolean).join("\n");
  if (out && out.trim()) console.error("\n" + out.trimEnd());
}

function rel(p: string): string {
  const r = path.relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
}
