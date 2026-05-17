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

  // Per-process agent identity. The supervisor runs as config.agent (default
  // "daedalus"); per-message agent containers spawned by ContainerAgentDispatcher
  // set DAE_ONECLI_AGENT to the specific agent's name so OneCLI scopes credential
  // injection to whatever THAT agent has been granted — not the supervisor.
  const agentIdentifier = process.env.DAE_ONECLI_AGENT ?? config.agent;

  const onecli = new OneCLI({ url: config.baseUrl, apiKey });
  let bundle: Awaited<ReturnType<typeof onecli.getContainerConfig>>;
  try {
    bundle = await onecli.getContainerConfig(agentIdentifier);
  } catch (err) {
    log.error(
      { err, baseUrl: config.baseUrl, agent: agentIdentifier },
      "OneCLI getContainerConfig failed — outbound traffic will NOT be proxied. Check that the agent exists and the daemon API key is valid.",
    );
    return;
  }

  const rawProxyUrl = bundle.env.HTTPS_PROXY ?? bundle.env.HTTP_PROXY;
  if (!rawProxyUrl) {
    log.warn({ env: bundle.env }, "OneCLI returned no HTTPS_PROXY — skipping");
    return;
  }
  // OneCLI's container-config bundle is tuned for *containers*: the proxy host comes
  // back as `host.docker.internal`, which only resolves inside the Docker network.
  // When daedalus is itself a host process, that name has no DNS. Rewrite the proxy
  // host to whatever host already worked for the REST call (almost always the same
  // OneCLI install reachable at the same host) — preserves the userinfo (the agent
  // token OneCLI embeds in the URL) and the port.
  const proxyUrl = rewriteProxyHostForCaller(rawProxyUrl, config.baseUrl);

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

  // Mirror the gateway's env to process.env so any subprocesses inherit it. Rewrite
  // proxy URLs the same way — a `dae`-spawned container would also fail to resolve
  // `host.docker.internal` unless it's actually joined to the Docker network, and we
  // can't tell from here which case applies. If the caller knows otherwise they can
  // override via their own env.
  for (const [k, v] of Object.entries(bundle.env)) {
    process.env[k] =
      k === "HTTPS_PROXY" || k === "HTTP_PROXY" ? rewriteProxyHostForCaller(v, config.baseUrl) : v;
  }
  process.env.NODE_EXTRA_CA_CERTS = caPath;

  log.info(
    { proxy: redactProxyUrl(proxyUrl), agent: agentIdentifier, caPath },
    "OneCLI proxy enabled (MITM CA trusted via undici requestTls)",
  );
}

// Swap the proxy URL's host for the host we already reached successfully (baseUrl).
// No-op if the proxy host isn't `host.docker.internal` or if the baseUrl host IS that
// (meaning the caller is itself a container).
function rewriteProxyHostForCaller(proxyUrl: string, baseUrl: string): string {
  let proxy: URL;
  let base: URL;
  try {
    proxy = new URL(proxyUrl);
    base = new URL(baseUrl);
  } catch {
    return proxyUrl;
  }
  if (proxy.hostname !== "host.docker.internal") return proxyUrl;
  if (base.hostname === "host.docker.internal") return proxyUrl;
  proxy.hostname = base.hostname;
  return proxy.toString();
}

// The proxy URL embeds the per-agent access token as basic-auth userinfo. Don't
// dump that into the log file.
function redactProxyUrl(proxyUrl: string): string {
  try {
    const u = new URL(proxyUrl);
    if (u.username || u.password) {
      u.username = "***";
      u.password = "";
    }
    return u.toString();
  } catch {
    return proxyUrl;
  }
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
