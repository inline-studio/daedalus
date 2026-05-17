import type { ArtemisConfig, AgentManifest } from "../config/schema.js";
import type { SecretsBackend } from "../secrets/store/base.js";
import { log } from "../log.js";

// Canonical env-var name per provider. Resolution chain at agent-start:
//   1. config.providers.<provider>.apiKey  (explicit YAML override; advanced)
//   2. process.env[CANONICAL_NAME]         (shell, .env, .env.local)
//   3. SecretsBackend.get(CANONICAL_NAME)  (env-file backend only — OneCLI never reveals)
//   4. OneCLI proxy enabled?               (send a placeholder; gateway injects real key)
//   5. fail loudly with a fix-it hint
//
// Mutates config in place — sets config.providers.<provider>.apiKey to the resolved value.
// Idempotent.

const CANONICAL_NAME: Record<AgentManifest["provider"], string | null> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  ollama: null, // ollama doesn't authenticate by default
};

const ONECLI_PLACEHOLDER = "onecli-managed";

export async function resolveProviderKey(
  agent: AgentManifest,
  config: ArtemisConfig,
  backend: SecretsBackend,
): Promise<void> {
  const provider = agent.provider;

  // Ollama doesn't authenticate by default; the adapter hardcodes "ollama" as the key
  // string. Nothing to resolve.
  const envName = CANONICAL_NAME[provider];
  if (!envName) return;

  // From here on we know the provider has an apiKey field on its config block (anthropic
  // or openai). Ensure the block exists so we have somewhere to write the resolved key.
  // The cast is safe because we've narrowed off ollama via the early return above.
  const providers = config.providers as Record<string, { apiKey?: string; baseUrl?: string }>;
  providers[provider] ??= {};
  const block = providers[provider]!;

  // 1. explicit override in YAML
  if (block.apiKey) return;

  // 2. shell / dotenv
  if (process.env[envName]) {
    block.apiKey = process.env[envName];
    return;
  }

  // 3. SecretsBackend
  try {
    const fromBackend = await backend.get(envName);
    if (fromBackend) {
      block.apiKey = fromBackend;
      // hydrate process.env so other consumers (transcribe, search, etc.) see it
      process.env[envName] = fromBackend;
      return;
    }
  } catch (err) {
    log.warn({ provider, err }, "secrets backend lookup failed; continuing");
  }

  // 4. OneCLI proxy will swap a placeholder for the real key at the network edge
  if (config.onecli.enabled) {
    block.apiKey = ONECLI_PLACEHOLDER;
    return;
  }

  throw new Error(
    `No API key available for provider '${provider}' (agent '${agent.name}').\n` +
      `Provide one of:\n` +
      `  • dae secret save ${envName}\n` +
      `  • export ${envName}=...    (or add it to .env.local beside your config)\n` +
      `  • enable the OneCLI proxy: set onecli.enabled: true in daedalus.config.yaml\n` +
      `  • set providers.${provider}.apiKey explicitly in the config file (NOT recommended for real keys)`,
  );
}
