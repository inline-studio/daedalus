// Unit smoke for the web channel's auth helpers: scrypt password hashing, signed session
// cookies, and cookie parsing. These back the built-in /login (so a deployment doesn't need
// the reverse proxy's basic_auth).

import { hashPassword, verifyPassword, signSession, verifySession, parseCookies } from "../dist/channels/web-auth.js";

let pass = true;
const ok = (label, cond) => {
  console.log(`${cond ? "✓" : "✗"} ${label}`);
  if (!cond) pass = false;
};

// --- password hashing ---
const h = hashPassword("hunter2");
ok("hash is self-describing scrypt", /^scrypt\$\d+\$\d+\$\d+\$/.test(h));
ok("two hashes of the same password differ (random salt)", hashPassword("hunter2") !== h);
ok("verify accepts the correct password", verifyPassword("hunter2", h) === true);
ok("verify rejects a wrong password", verifyPassword("nope", h) === false);
ok("verify rejects a malformed hash", verifyPassword("hunter2", "garbage") === false);

// --- signed session cookies ---
const secret = "session-signing-secret";
const tok = signSession("alice", secret, 60_000);
ok("valid session verifies to its username", verifySession(tok, secret) === "alice");
ok("session under a different secret is rejected", verifySession(tok, "other-secret") === null);
ok("tampered session is rejected", verifySession(tok.slice(0, -2) + "zz", secret) === null);
ok("garbage token is rejected", verifySession("not-a-token", secret) === null);
ok("expired session is rejected", verifySession(signSession("bob", secret, -1000), secret) === null);

// --- cookie parsing ---
const c = parseCookies("a=1; dae_session=abc.def; b=2");
ok("parses multiple cookies", c.a === "1" && c.dae_session === "abc.def" && c.b === "2");
ok("missing header → empty map", Object.keys(parseCookies(undefined)).length === 0);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
