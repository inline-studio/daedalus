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

  // Make sure THIS agent exists in OneCLI before asking for its container config —
  // a fresh gateway has no agents, so getContainerConfig would 404. ensureAgent is
  // idempotent (creates if missing, no-op otherwise). Non-fatal: if it fails we
  // still try getContainerConfig and let that surface the real error.
  try {
    await onecli.ensureAgent({ name: agentIdentifier, identifier: agentIdentifier });
  } catch (err) {
    log.warn({ err, agent: agentIdentifier }, "OneCLI ensureAgent failed — continuing");
  }

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

  // Mirror the gateway's env to process.env so any subprocesses inherit it, rewriting
  // the proxy host the same way (host.docker.internal → the host we actually reached).
  Object.assign(process.env, rewriteBundleEnv(bundle.env, config.baseUrl));

  // Trust the MITM CA in every runtime an agent reaches for. Node uses
  // NODE_EXTRA_CA_CERTS (appended to its built-ins); the subprocess tooling agents
  // shell out to needs the file-based vars: curl/git/openssl read CURL_CA_BUNDLE +
  // SSL_CERT_FILE, and Go CLIs (gh, doctl) read SSL_CERT_FILE. Without these, npm
  // worked (it's node) but every curl/gh/doctl call failed TLS through the proxy.
  // (All external traffic goes through the proxy, which presents this CA, so trusting
  // it alone is sufficient.)
  process.env.NODE_EXTRA_CA_CERTS = caPath;
  process.env.CURL_CA_BUNDLE = caPath;
  process.env.SSL_CERT_FILE = caPath;

  log.info(
    { proxy: redactProxyUrl(proxyUrl), agent: agentIdentifier, caPath },
    "OneCLI proxy enabled (MITM CA trusted via undici requestTls)",
  );
}

// Copy the gateway bundle's env, rewriting the proxy host on EVERY proxy variable.
// OneCLI ships both upper- and lower-case (HTTPS_PROXY *and* https_proxy, etc.), and
// npm + curl read the LOWERCASE ones — so rewriting only the uppercase keys (the old
// bug) left npm/curl pointed at `host.docker.internal`, which doesn't resolve inside
// the agent container. That stalled every skill bootstrap (~70s of npm retries) and
// broke curl-based ones outright. NO_PROXY is a bypass list, not a host to reach, so
// it's left untouched.
export function rewriteBundleEnv(
  bundleEnv: Record<string, string>,
  baseUrl: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(bundleEnv)) {
    out[k] = isProxyEnvVar(k) ? rewriteProxyHostForCaller(v, baseUrl) : v;
  }
  return out;
}

// http_proxy / https_proxy / all_proxy, in any case.
function isProxyEnvVar(key: string): boolean {
  return /^(https?|all)_proxy$/i.test(key);
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
