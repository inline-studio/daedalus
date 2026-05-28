// Smoke for humanizeTurnError — turns raw provider errors into user-facing text.
//
// The bug it addresses: when the spark went offline, the user saw
//
//   Error: agent worker turn failed (HTTP 500): OpenAI-compatible completion
//   failed: Connection error.: Connection error.: fetch failed: other side closed
//
// in Telegram. Useless. The classifier returns a plain-English explanation
// plus a brief technical hint so the operator can self-diagnose.
//
// Coverage: the exact spark-down chain that motivated this, every distinct
// category (auth, rate-limit, timeout, context-overflow, bad-request,
// worker-down, unknown), and shape invariants (no raw stack, technical hint
// present, category correct).

import { humanizeTurnError } from "../dist/kernel/error-message.js";

let pass = true;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) pass = false;
};

// ─── 1. Scott's exact spark-down chain ──────────────────────────────────────
{
  // Reproduce the OpenAI SDK + undici 4-deep wrap.
  const inner3 = Object.assign(new Error("other side closed"), { name: "SocketError" });
  const inner2 = new TypeError("fetch failed", { cause: inner3 });
  const inner1 = new Error("Connection error.", { cause: inner2 });
  const provider = Object.assign(
    new Error("OpenAI-compatible completion failed: Connection error."),
    { name: "ProviderError", cause: inner1 },
  );
  // …then the persistent-worker dispatcher wraps it again as "HTTP 500".
  const dispatched = new Error(
    `agent worker turn failed (HTTP 500): ${provider.message}: Connection error.: fetch failed: other side closed`,
  );

  const c = humanizeTurnError(dispatched);
  ok("spark-down: category is 'upstream-down'", c.category === "upstream-down", c.category);
  ok("spark-down: user message explains it in plain English", /couldn't reach|upstream/i.test(c.userMessage));
  ok("spark-down: user message tells operator what to check", /spark|litellm|endpoint/i.test(c.userMessage));
  ok("spark-down: technical hint included for self-diagnosis", /technical/i.test(c.userMessage));
  ok("spark-down: hint surfaces the actual signal", /other side closed|fetch failed|connection/i.test(c.userMessage));
  ok("spark-down: no raw stack leaks to user", !/at\s+\w+\s*\(.+\.js:\d+:\d+\)/.test(c.userMessage));
}

// ─── 2. each category in isolation ──────────────────────────────────────────

// Worker-down: distinct from upstream-down — the agent worker container itself
// isn't reachable, not the LLM endpoint.
{
  const e = new Error("agent worker unreachable at http://dae-worker:10260: fetch failed");
  const c = humanizeTurnError(e);
  ok("worker-down: category", c.category === "worker-down", c.category);
  ok("worker-down: tells operator to check compose", /docker compose ps|dae-worker/i.test(c.userMessage));
}

// Auth: 401 + the OpenAI message phrasing.
{
  const e = Object.assign(new Error("Unauthorized: invalid API key provided"), { status: 401 });
  const c = humanizeTurnError(e);
  ok("auth: category", c.category === "auth", c.category);
  ok("auth: tells operator about OneCLI", /onecli|dae secret/i.test(c.userMessage));
}
{
  // status-less variant (the OpenAI SDK sometimes only sets it on the inner cause).
  const e = new Error("invalid api key");
  ok("auth: 'invalid api key' phrase alone", humanizeTurnError(e).category === "auth");
}

// Rate limit: 429.
{
  const e = Object.assign(new Error("Rate limit exceeded"), { status: 429 });
  const c = humanizeTurnError(e);
  ok("rate-limit: category", c.category === "rate-limit", c.category);
  ok("rate-limit: tells user to wait", /wait|again/i.test(c.userMessage));
}

// Timeout (distinct from connection error — the request itself completed its
// connection but the server didn't reply in time).
{
  const e = Object.assign(new Error("Request timed out after 60s"), { status: 408 });
  const c = humanizeTurnError(e);
  ok("timeout: category", c.category === "timeout", c.category);
  ok("timeout: suggests faster model", /faster model|timed out/i.test(c.userMessage));
}

// Context overflow: the compactor gave up.
{
  const e = new Error("Prompt is too long: context_length_exceeded");
  const c = humanizeTurnError(e);
  ok("context-overflow: category", c.category === "context-overflow", c.category);
  ok("context-overflow: suggests fresh thread / larger model", /fresh thread|larger context/i.test(c.userMessage));
}

// Bad request: 400.
{
  const e = Object.assign(new Error("Bad request: invalid model 'gptt-4'"), { status: 400 });
  const c = humanizeTurnError(e);
  ok("bad-request: category", c.category === "bad-request", c.category);
  ok("bad-request: hints model-name typo / schema", /model-name typo|tool-schema/i.test(c.userMessage));
}

// 5xx server error (without explicit transport phrasing) — still upstream-down.
{
  const e = Object.assign(new Error("HTTP 503 Service Unavailable"), { status: 503 });
  const c = humanizeTurnError(e);
  ok("5xx: category is upstream-down", c.category === "upstream-down", c.category);
}

// Unknown: a non-classifiable error still produces a sane message.
{
  const e = new Error("something exotic and unexpected");
  const c = humanizeTurnError(e);
  ok("unknown: category", c.category === "unknown", c.category);
  ok("unknown: user message is non-empty + apologetic", /went wrong/i.test(c.userMessage));
}

// ─── 3. category-routing precedence ─────────────────────────────────────────
// A single error can match multiple regex patterns (e.g. "Connection error"
// matches upstream-down's pattern AND mentions "error" generally). The
// classifier checks the most specific categories first; verify the routing.
{
  // "context_length_exceeded" wins over a generic connection mention.
  const e = new Error("connection error: context_length_exceeded");
  ok(
    "precedence: context-overflow beats upstream-down phrasing",
    humanizeTurnError(e).category === "context-overflow",
  );
}
{
  // 401 status wins over a fetch-failed message in the body (the auth
  // failure is the actionable signal; the connection blip is incidental).
  const e = Object.assign(new Error("fetch failed (status 401)"), { status: 401 });
  ok(
    "precedence: auth (status) beats upstream-down (fetch failed)",
    humanizeTurnError(e).category === "auth",
  );
}

// ─── 4. cycle-safety + null safety ──────────────────────────────────────────
{
  const a = new Error("a — fetch failed");
  const b = new Error("b");
  Object.defineProperty(a, "cause", { value: b, enumerable: false });
  Object.defineProperty(b, "cause", { value: a, enumerable: false });
  // Should terminate.
  const timer = setTimeout(() => {
    ok("cycle terminates", false, "humanizeTurnError didn't return in 1s");
    process.exit(1);
  }, 1000);
  const c = humanizeTurnError(a);
  clearTimeout(timer);
  ok("cycle terminates + still classifies", c.category === "upstream-down");
}
{
  // null / undefined / primitives just produce 'unknown' without throwing.
  ok("null doesn't throw", humanizeTurnError(null).category === "unknown");
  ok("undefined doesn't throw", humanizeTurnError(undefined).category === "unknown");
  ok("a string doesn't throw", humanizeTurnError("nope").category === "unknown");
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
