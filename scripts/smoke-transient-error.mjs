// Smoke for isTransientLLMError — the predicate that decides whether
// completeWithRetry should retry an LLM call.
//
// Why this exists: the function previously walked only one level of `.cause`,
// so OpenAI SDK errors (which wrap the actual transport SocketError 3+
// layers deep) got classified as non-transient and never retried. A single
// upstream blip surfaced to the user as a hard "Connection error." with no
// retry attempts in the log — exactly what bit Scott when his agent was
// generating a long multi-step plan and his spark/LiteLLM idle-timed-out
// the connection mid-stream. The fix walks the full chain AND adds the
// "other side closed" / "premature close" patterns undici emits.
//
// What's covered:
//   1. The bug itself: the OpenAI SDK 4-deep chain ending in
//      SocketError("other side closed") is now recognised as transient.
//   2. Each transport phrase undici might emit:
//      "fetch failed", "other side closed", "socket hang up",
//      "premature close", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED".
//   3. HTTP status routing: 408, 425, 429, 5xx retry; 400/401/403/404 don't.
//   4. Status found anywhere in the cause chain still counts.
//   5. Real bad-request errors stay non-transient (no false-positive
//      retries on 4xx — those will never succeed).
//   6. Cycle safety: a cause that points back at an ancestor doesn't loop.

import { isTransientLLMError } from "../dist/kernel/agent.js";

let pass = true;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) pass = false;
};

// ─── 1. Scott's exact error: the OpenAI SDK + undici 4-deep chain ───────────
{
  const inner3 = Object.assign(new Error("other side closed"), { name: "SocketError" });
  const inner2 = new TypeError("fetch failed", { cause: inner3 });
  const inner1 = new Error("Connection error.", { cause: inner2 });
  const top = Object.assign(
    new Error("OpenAI-compatible completion failed: Connection error."),
    { name: "ProviderError", cause: inner1 },
  );
  ok(
    "the exact OpenAI SDK + undici chain is recognised as transient",
    isTransientLLMError(top) === true,
  );
}

// ─── 2. each transport phrase undici might emit ─────────────────────────────
const transportPhrases = [
  "fetch failed",
  "other side closed",
  "socket hang up",
  "SocketError: other side closed",
  "premature close",
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ECONNABORTED",
  "EPIPE",
  "EAI_AGAIN",
  "connection reset by peer",
  "connection closed",
  "connection aborted",
];
for (const phrase of transportPhrases) {
  const e = new Error(phrase);
  ok(`'${phrase}' classifies as transient`, isTransientLLMError(e) === true);
}

// ─── 3. HTTP status routing ──────────────────────────────────────────────────
const transientStatuses = [408, 425, 429, 500, 502, 503, 504];
for (const s of transientStatuses) {
  const e = Object.assign(new Error(`HTTP ${s}`), { status: s });
  ok(`status ${s} classifies as transient`, isTransientLLMError(e) === true);
}
const permanentStatuses = [400, 401, 403, 404, 422];
for (const s of permanentStatuses) {
  const e = Object.assign(new Error(`HTTP ${s}`), { status: s });
  ok(`status ${s} classifies as NOT transient`, isTransientLLMError(e) === false);
}

// ─── 4. status hidden inside the cause chain still counts ───────────────────
{
  const inner = Object.assign(new Error("upstream HTTP 503"), { status: 503 });
  const top = new Error("provider failed", { cause: inner });
  ok("status on a nested .cause is honoured", isTransientLLMError(top) === true);
}

// ─── 5. real bad-request errors stay non-transient (no false positive) ──────
{
  const e = Object.assign(new Error("Bad request: invalid input.model"), { status: 400 });
  ok("a real 400 doesn't get retried", isTransientLLMError(e) === false);
}
{
  // Auth failures — important not to spin on these.
  const e = Object.assign(new Error("Unauthorized"), { status: 401 });
  ok("a 401 doesn't get retried", isTransientLLMError(e) === false);
}
{
  // A non-transport message with no status: an actual model/parse failure.
  // Should NOT be classified as transient just because we're being permissive.
  const e = new Error("Tool call schema validation failed: foo is not a valid argument");
  ok("a non-transport non-status error is not transient", isTransientLLMError(e) === false);
}

// ─── 6. cycle safety ─────────────────────────────────────────────────────────
{
  const a = new Error("a — fetch failed"); // <-- transient phrase so we know walking found it
  const b = new Error("b");
  // Build a cycle: a.cause = b, b.cause = a.
  Object.defineProperty(b, "cause", { value: a, enumerable: false });
  Object.defineProperty(a, "cause", { value: b, enumerable: false });
  // Should terminate AND still find the transient phrase.
  let returned = false;
  const timer = setTimeout(() => {
    if (!returned) {
      ok("cycle terminates without hanging", false, "isTransientLLMError didn't return in 1s");
      process.exit(1);
    }
  }, 1000);
  const result = isTransientLLMError(a);
  returned = true;
  clearTimeout(timer);
  ok("cycle terminates and still finds the transient phrase", result === true);
}

// ─── 7. null / undefined / primitives don't blow up ─────────────────────────
ok("null is not transient (and doesn't throw)", isTransientLLMError(null) === false);
ok("undefined is not transient (and doesn't throw)", isTransientLLMError(undefined) === false);
ok("a string is not transient (and doesn't throw)", isTransientLLMError("just text") === false);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
