// Smoke for OneCLI proxy-env rewriting.
//
// The gateway bundle ships proxy vars in BOTH cases (HTTPS_PROXY and https_proxy …)
// with host `host.docker.internal`. npm + curl read the lowercase ones, so rewriting
// only the uppercase keys left them pointed at an unresolvable host inside the agent
// container — stalling every skill bootstrap. These checks lock in that EVERY proxy
// variant gets the host rewritten, and non-proxy vars are left alone.

import { rewriteBundleEnv } from "../dist/secrets/onecli.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const PROXY = "http://oc_tok@host.docker.internal:10255";
const bundle = {
  HTTPS_PROXY: PROXY,
  HTTP_PROXY: PROXY,
  https_proxy: PROXY,
  http_proxy: PROXY,
  ALL_PROXY: PROXY,
  all_proxy: PROXY,
  NO_PROXY: "localhost,127.0.0.1,host.docker.internal",
  no_proxy: "localhost,127.0.0.1,host.docker.internal",
  ANTHROPIC_API_KEY: "placeholder",
};

const out = rewriteBundleEnv(bundle, "http://onecli:10254");

for (const k of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy", "ALL_PROXY", "all_proxy"]) {
  expect(
    `${k} host rewritten to onecli`,
    out[k].includes("@onecli:10255") && !out[k].includes("host.docker.internal"),
    out[k],
  );
  expect(`${k} preserves the embedded token`, out[k].includes("oc_tok"), out[k]);
}
expect("NO_PROXY left untouched (it's a bypass list)", out.NO_PROXY === bundle.NO_PROXY, out.NO_PROXY);
expect("no_proxy left untouched", out.no_proxy === bundle.no_proxy, out.no_proxy);
expect("non-proxy var left untouched", out.ANTHROPIC_API_KEY === "placeholder", out.ANTHROPIC_API_KEY);

// A proxy that's already correct (not host.docker.internal) must be a no-op.
const out2 = rewriteBundleEnv({ https_proxy: "http://oc_tok@onecli:10255" }, "http://onecli:10254");
expect("already-correct proxy unchanged", out2.https_proxy === "http://oc_tok@onecli:10255", out2.https_proxy);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
