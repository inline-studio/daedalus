// SEC-04: SSRF guard for the fetch tools. web_fetch / attachment fetch must refuse private,
// loopback, link-local and cloud-metadata destinations (and non-http schemes) before
// connecting, while leaving public hosts — and therefore the OneCLI key-swap path — untouched.
// Uses literal IPs + an exact-host allowlist so the test is deterministic (no DNS/network).

import { isBlockedIp, assertPublicHostAllowed, SsrfBlockedError } from "../dist/web/ssrf.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// Was assertPublicHostAllowed rejected? (async)
async function blocked(url, allow = []) {
  try {
    await assertPublicHostAllowed(url, allow);
    return false;
  } catch (e) {
    return e instanceof SsrfBlockedError;
  }
}

// --- isBlockedIp: ranges ---------------------------------------------------------------
expect("169.254.169.254 (metadata) blocked", isBlockedIp("169.254.169.254"));
expect("127.0.0.1 (loopback) blocked", isBlockedIp("127.0.0.1"));
expect("10.0.0.5 (private) blocked", isBlockedIp("10.0.0.5"));
expect("172.16.0.1 (private) blocked", isBlockedIp("172.16.0.1"));
expect("172.31.255.255 (private edge) blocked", isBlockedIp("172.31.255.255"));
expect("172.32.0.1 (just outside private) allowed", !isBlockedIp("172.32.0.1"));
expect("192.168.1.1 (private) blocked", isBlockedIp("192.168.1.1"));
expect("0.0.0.0 blocked", isBlockedIp("0.0.0.0"));
expect("100.64.0.1 (CGNAT) blocked", isBlockedIp("100.64.0.1"));
expect("::1 (v6 loopback) blocked", isBlockedIp("::1"));
expect("fe80::1 (v6 link-local) blocked", isBlockedIp("fe80::1"));
expect("fc00::1 (v6 ULA) blocked", isBlockedIp("fc00::1"));
expect("::ffff:127.0.0.1 (v4-mapped loopback) blocked", isBlockedIp("::ffff:127.0.0.1"));
expect("1.1.1.1 (public) allowed", !isBlockedIp("1.1.1.1"));
expect("8.8.8.8 (public) allowed", !isBlockedIp("8.8.8.8"));
expect("2606:4700:4700::1111 (public v6) allowed", !isBlockedIp("2606:4700:4700::1111"));

// --- assertPublicHostAllowed: schemes ---------------------------------------------------
expect("file:// scheme blocked", await blocked("file:///etc/passwd"));
expect("ftp:// scheme blocked", await blocked("ftp://example.com/x"));
expect("gopher:// scheme blocked", await blocked("gopher://x"));

// --- assertPublicHostAllowed: literal internal hosts ------------------------------------
expect("http://169.254.169.254 blocked", await blocked("http://169.254.169.254/latest/meta-data/"));
expect("http://127.0.0.1 blocked", await blocked("http://127.0.0.1:8765/"));
expect("http://[::1] blocked", await blocked("http://[::1]:9000/"));
expect("http://10.1.2.3 blocked", await blocked("http://10.1.2.3/"));
expect("http://192.168.0.1 blocked", await blocked("http://192.168.0.1/"));
expect("http://localhost blocked", await blocked("http://localhost:3000/"));

// --- public literal IP allowed (no DNS) -------------------------------------------------
expect("http://1.1.1.1 allowed", !(await blocked("http://1.1.1.1/")));

// --- allowlist bypass -------------------------------------------------------------------
expect("allowlisted internal IP passes", !(await blocked("http://10.0.0.5/", ["10.0.0.5"]))); // exact host
expect("allowlist is exact-host (different host still blocked)", await blocked("http://10.0.0.6/", ["10.0.0.5"]));

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
