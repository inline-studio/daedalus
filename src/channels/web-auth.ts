import { scryptSync, randomBytes, createHmac, timingSafeEqual } from "node:crypto";

// Self-contained auth helpers for the web channel's built-in login (no external deps):
//   - password hashing with scrypt (store only the hash in .env.local)
//   - stateless signed session cookies (HMAC-SHA256 over a tiny payload)
//   - cookie parsing
//
// The web channel uses these to offer its own username/password login page so a deployment
// doesn't need to lean on the reverse proxy's basic_auth.

const SCRYPT_KEYLEN = 32;
// scrypt cost params. N must be a power of two; these are a sensible interactive default.
const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;

// Produce a self-describing hash string: `scrypt$<N>$<r>$<p>$<saltB64>$<hashB64>`.
// Storing the params inline lets verifyPassword stay correct if we ever tune them.
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

// Constant-time verify of a password against a stored `scrypt$…` hash. Returns false on any
// malformed input rather than throwing, so a corrupt env var just fails the login.
export function verifyPassword(password: string, stored: string): boolean {
  try {
    const parts = stored.split("$");
    if (parts.length !== 6 || parts[0] !== "scrypt") return false;
    const N = Number(parts[1]);
    const r = Number(parts[2]);
    const p = Number(parts[3]);
    const salt = Buffer.from(parts[4]!, "base64");
    const expected = Buffer.from(parts[5]!, "base64");
    if (!N || !r || !p || salt.length === 0 || expected.length === 0) return false;
    const actual = scryptSync(password, salt, expected.length, { N, r, p });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

interface SessionPayload {
  u: string; // authenticated username
  exp: number; // expiry, epoch ms
}

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Mint a stateless session token: `<payloadB64url>.<hmacB64url>`. No server-side store —
// validity is proven by the HMAC over the payload with the secret.
export function signSession(username: string, secret: string, ttlMs: number): string {
  const payload: SessionPayload = { u: username, exp: Date.now() + ttlMs };
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

// Verify a session token and return its username, or null if invalid/expired/tampered.
export function verifySession(token: string, secret: string): string | null {
  try {
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const expected = b64url(createHmac("sha256", secret).update(body).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(Buffer.from(body.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8")) as SessionPayload;
    if (!payload.u || typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload.u;
  } catch {
    return null;
  }
}

// Parse a Cookie header into a flat map. Tolerant of spaces and missing values.
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    const k = pair.slice(0, eq).trim();
    const v = pair.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
