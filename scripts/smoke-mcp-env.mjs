// SEC-07 / SEC-11: spawned children (stdio MCP servers, skill bootstrap.sh) must NOT inherit
// the supervisor's whole environment (every API key/token). safeChildEnv passes only
// operational vars + OneCLI proxy/CA plumbing; secrets are excluded, and the caller layers its
// own explicit vars (def.env / DAE_SKILL_*) on top.

import { safeChildEnv } from "../dist/secrets/safe-env.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const fakeEnv = {
  PATH: "/usr/bin",
  HOME: "/home/dae",
  LANG: "en_US.UTF-8",
  LC_TIME: "en_GB.UTF-8",
  TZ: "Europe/London",
  HTTPS_PROXY: "http://onecli:8080",
  https_proxy: "http://onecli:8080",
  NODE_EXTRA_CA_CERTS: "/tmp/ca.pem",
  // secrets that must NOT pass through:
  ANTHROPIC_API_KEY: "sk-ant-xxx",
  OPENAI_API_KEY: "sk-xxx",
  TELEGRAM_BOT_TOKEN: "123:abc",
  WEB_SESSION_SECRET: "deadbeef",
  SECRET_ENCRYPTION_KEY: "k",
  MEMPALACE_TOKEN: "t",
  ONECLI_API_KEY: "oc_xxx",
  RANDOM_THING: "whatever",
};

const out = safeChildEnv(fakeEnv);

// Operational vars pass through:
for (const k of ["PATH", "HOME", "LANG", "LC_TIME", "TZ", "HTTPS_PROXY", "https_proxy", "NODE_EXTRA_CA_CERTS"]) {
  expect(`passes ${k}`, out[k] === fakeEnv[k]);
}
// Secrets are stripped:
for (const k of [
  "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TELEGRAM_BOT_TOKEN", "WEB_SESSION_SECRET",
  "SECRET_ENCRYPTION_KEY", "MEMPALACE_TOKEN", "ONECLI_API_KEY", "RANDOM_THING",
]) {
  expect(`strips ${k}`, !(k in out));
}
// def.env layering is the caller's job — baseMcpEnv only returns the allowlisted base.
expect("undefined values are skipped", safeChildEnv({ PATH: undefined, HOME: "/h" }).PATH === undefined);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
