import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ProxyAgent, setGlobalDispatcher } from "undici";
import { OneCLI } from "@onecli-sh/sdk";
import type { OneCliConfig } from "../config/schema.js";
import { log } from "../log.js";

// OneCLI is an HTTPS-MITM credential gateway. At startup we fetch its container-config
// bundle (proxy URL, env vars, MITM CA cert) over its REST API, then wire undici's global
// dispatcher to route all outbound traffic through the proxy and trust the MITM CA.
// From then on, the Anthropic SDK / OpenAI SDK / anything using global fetch sends
// requests that OneCLI can decrypt, inject the matching credential into, and forward.
//
// Containers we spawn later (docker runtime) inherit HTTPS_PROXY / NODE_EXTRA_CA_CERTS
// via process.env so they get the same treatment without duplicating the wiring.
export async function applyOneCli(config: OneCliConfig): Promise<void> {
  if (!config.enabled) return;

  const apiKey = resolveDaemonApiKey(config);
  if (!apiKey) {
    log.warn(
      {
        baseUrl: config.baseUrl,
        tried: ["config.onecli.apiKey", "env.ONECLI_API_KEY", "~/.onecli/credentials/api-key"],
      },
      "OneCLI enabled but no daemon API key found — skipping proxy setup. Run `dae setup onecli`.",
    );
    return;
  }

  const onecli = new OneCLI({ url: config.baseUrl, apiKey });
  let bundle: Awaited<ReturnType<typeof onecli.getContainerConfig>>;
  try {
    bundle = await onecli.getContainerConfig(config.agent);
  } catch (err) {
    log.error(
      { err, baseUrl: config.baseUrl, agent: config.agent },
      "OneCLI getContainerConfig failed — outbound traffic will NOT be proxied. Check that the agent exists and the daemon API key is valid.",
    );
    return;
  }

  const proxyUrl = bundle.env.HTTPS_PROXY ?? bundle.env.HTTP_PROXY;
  if (!proxyUrl) {
    log.warn({ env: bundle.env }, "OneCLI returned no HTTPS_PROXY — skipping");
    return;
  }

  // Write the MITM CA to a tmp file. Node's NODE_EXTRA_CA_CERTS env var only takes effect
  // at process start, so we can't add the CA to the in-process default TLS context after
  // the fact. Two consequences: (1) for our own outbound traffic we install it via
  // undici's ProxyAgent({ requestTls: { ca } }); (2) for spawned child processes we set
  // NODE_EXTRA_CA_CERTS so they pick it up at their start.
  const caPath = join(tmpdir(), `onecli-proxy-ca-${process.pid}.pem`);
  writeFileSync(caPath, bundle.caCertificate);

  const proxyAgent = new ProxyAgent({
    uri: proxyUrl,
    requestTls: { ca: bundle.caCertificate },
  });
  setGlobalDispatcher(proxyAgent);

  for (const [k, v] of Object.entries(bundle.env)) {
    process.env[k] = v;
  }
  process.env.NODE_EXTRA_CA_CERTS = caPath;

  log.info(
    { proxy: proxyUrl, agent: config.agent, caPath },
    "OneCLI proxy enabled (MITM CA trusted via undici requestTls)",
  );
}

// Resolution order:
//   1. config.onecli.apiKey   (explicit YAML)
//   2. process.env.ONECLI_API_KEY
//   3. ~/.onecli/credentials/api-key  (file dropped by the `onecli` CLI on local installs)
export function resolveDaemonApiKey(config: OneCliConfig): string | undefined {
  if (config.apiKey) return config.apiKey;
  if (process.env.ONECLI_API_KEY) return process.env.ONECLI_API_KEY;
  const credPath = join(homedir(), ".onecli", "credentials", "api-key");
  if (!existsSync(credPath)) return undefined;
  try {
    const raw = readFileSync(credPath, "utf8").trim();
    // The file format is JSON ({"apiKey":"oc_..."}) on newer OneCLI installs and a bare
    // string on older ones. Accept either.
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw) as { apiKey?: string };
      return parsed.apiKey;
    }
    return raw || undefined;
  } catch (err) {
    log.warn({ err, credPath }, "failed to read OneCLI api-key file");
    return undefined;
  }
}
