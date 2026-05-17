import path from "node:path";
import type { ArtemisConfig } from "../../config/schema.js";
import type { SecretsBackend } from "./base.js";
import { EnvFileSecretsBackend } from "./env-file-backend.js";
import { OneCliSecretsBackend } from "./onecli-backend.js";
import { resolveDaemonApiKey } from "../onecli.js";
import { log } from "../../log.js";

export interface BuildSecretsOptions {
  // Where the env-file backend writes when no absolute path is given. Usually the dir of
  // the daedalus config file so .env.local sits beside it.
  envFileBaseDir: string;
}

// Resolve which backend to use:
//   secrets.backend == "onecli"   → OneCLI
//   secrets.backend == "env-file" → env-file
//   secrets.backend == "auto"     → OneCLI if reachable, else env-file
export async function buildSecretsBackend(
  config: ArtemisConfig,
  opts: BuildSecretsOptions,
): Promise<SecretsBackend> {
  const cfg = config.secrets;
  const envFilePath = path.isAbsolute(cfg.envFile.path)
    ? cfg.envFile.path
    : path.resolve(opts.envFileBaseDir, cfg.envFile.path);
  const envBackend = new EnvFileSecretsBackend(envFilePath);

  if (cfg.backend === "env-file") return envBackend;

  // Daemon API key is shared with the runtime proxy (config.onecli.apiKey, env,
  // ~/.onecli/credentials/api-key). secrets.onecli.token is honored as an explicit
  // override but most users won't need to set it separately.
  const token = cfg.onecli.token ?? resolveDaemonApiKey(config.onecli);
  const oneCli = new OneCliSecretsBackend({
    baseUrl: cfg.onecli.baseUrl,
    ...(token ? { token } : {}),
  });

  if (cfg.backend === "onecli") return oneCli;

  // auto
  const reachable = await oneCli.ping();
  if (reachable) {
    log.debug({ baseUrl: cfg.onecli.baseUrl }, "secrets: OneCLI reachable, using onecli backend");
    return oneCli;
  }
  log.debug("secrets: OneCLI not reachable, falling back to env-file backend");
  return envBackend;
}
