// SEC-07 / SEC-11: the allowlist of operational environment variables that are safe to hand a
// spawned child process (a stdio MCP server, a skill `bootstrap.sh`) — never the supervisor's
// secrets (API keys, tokens, the encryption key). Includes the OneCLI proxy + MITM-CA vars so
// the child's own outbound traffic is still proxied / credential-injected correctly. The LC_*
// locale family is matched by prefix in safeChildEnv().
export const SAFE_CHILD_ENV = new Set([
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM",
  "LANG", "TZ", "TMPDIR", "TEMP",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY",
  "http_proxy", "https_proxy", "no_proxy", "all_proxy",
  "NODE_EXTRA_CA_CERTS", "CURL_CA_BUNDLE", "SSL_CERT_FILE",
]);

// Build a child-process environment containing ONLY allowlisted operational vars from `env`.
// Callers layer their own explicit vars (e.g. DAE_SKILL_*) on top of the result. Exported for
// tests.
export function safeChildEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (SAFE_CHILD_ENV.has(k) || k.startsWith("LC_")) out[k] = v;
  }
  return out;
}
