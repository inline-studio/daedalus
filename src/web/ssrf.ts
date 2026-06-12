import dns from "node:dns/promises";
import net from "node:net";

// SEC-04 / SEC-05: SSRF guard for the fetch tools. `web_fetch` and the attachment fetch hand
// the model an arbitrary URL, so we refuse private / loopback / link-local / metadata
// destinations BEFORE connecting. Public hosts (real APIs) are never on the blocklist, so the
// normal fetch path — including the OneCLI proxy + dummy→real key swap — is unaffected.
//
// Caveat: when OneCLI is enabled the proxy makes the final connection and re-resolves DNS, so
// this client-side resolve-and-check is advisory against DNS rebinding (we resolve, the proxy
// re-resolves). It still blocks every literal-IP and resolvable-internal target, and is the
// ONLY guard on non-proxied deployments. The robust complement is OneCLI egress policy.

export class SsrfBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

// Is an IPv4 literal in a blocked (non-public) range?
function isBlockedIpv4(ip: string): boolean {
  const p = ip.split(".").map((n) => Number(n));
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  return false;
}

// Is an IP literal (v4 or v6) blocked? Unknown/invalid forms are blocked (fail safe).
export function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) return isBlockedIpv4(ip);
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/); // IPv4-mapped
    if (mapped) return isBlockedIpv4(mapped[1]!);
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique-local
    return false;
  }
  return true; // not a valid IP literal — be safe
}

// Throw SsrfBlockedError unless `rawUrl` is an http/https URL to a public destination.
// `allowHosts` is an exact-hostname allowlist (future-proof escape hatch; default empty).
export async function assertPublicHostAllowed(rawUrl: string, allowHosts: string[] = []): Promise<void> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(`web_fetch: invalid URL '${rawUrl}'`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new SsrfBlockedError(`web_fetch: blocked scheme '${u.protocol}' (only http/https allowed)`);
  }
  const host = u.hostname.toLowerCase().replace(/^\[/, "").replace(/\]$/, ""); // strip IPv6 brackets
  // Allowlist bypass — exact host match (covers an explicitly-trusted internal service).
  if (allowHosts.some((h) => h.toLowerCase() === host)) return;
  // Block loopback names outright (split-horizon DNS may not resolve them for us, but the
  // proxy could). Bare single-label internal names (e.g. `graphiti`) are caught by resolution.
  if (host === "" || host === "localhost" || host.endsWith(".localhost")) {
    throw new SsrfBlockedError(`web_fetch: blocked host '${host || "(empty)"}'`);
  }
  // Literal IP — check directly, no DNS.
  if (net.isIP(host)) {
    if (isBlockedIp(host)) {
      throw new SsrfBlockedError(`web_fetch: blocked address ${host} (private/loopback/link-local)`);
    }
    return;
  }
  // Hostname — resolve and reject if ANY address is internal. A resolution failure is left to
  // the fetch itself (an unresolvable host can't be connected to; not an internal-SSRF risk we
  // can verify here).
  let addrs: Array<{ address: string }>;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch {
    return;
  }
  for (const a of addrs) {
    if (isBlockedIp(a.address)) {
      throw new SsrfBlockedError(
        `web_fetch: blocked host '${host}' — resolves to internal address ${a.address}`,
      );
    }
  }
}
