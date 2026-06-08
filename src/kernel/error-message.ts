// Turn-failure classifier + user-facing message generator.
//
// When a turn dies, serve.ts used to send the user `Error: <raw err.message>`,
// which for the common spark-down case looked like:
//
//   Error: agent worker turn failed (HTTP 500): OpenAI-compatible completion
//   failed: Connection error.: Connection error.: fetch failed: other side closed
//
// That's incomprehensible to anyone who isn't reading the source. This
// classifier walks the error (including the cause chain AND any wrapped
// dispatcher / worker messages) to figure out WHAT went wrong, then returns a
// plain-English explanation plus a brief technical hint so the operator can
// self-diagnose without grepping `docker compose logs`.
//
// Categorisation is intentionally permissive — if we're not sure, we fall back
// to "unknown" and include the raw tail. False positives that surface a wrong
// hint are worse than a generic "something went wrong" message.

export type ErrorCategory =
  | "upstream-down" // can't reach the LLM endpoint (connection error, 5xx, blip)
  | "rate-limit" // 429 / "rate limit"
  | "timeout" // explicit timeout (408 or "timed out" string)
  | "auth" // 401/403 / "invalid api key"
  | "bad-request" // 400/422 / "bad request" / model name typo / schema issue
  | "context-overflow" // even after compaction, prompt doesn't fit
  | "worker-down" // agent-worker container itself is unreachable
  | "unknown";

export interface ClassifiedError {
  category: ErrorCategory;
  userMessage: string;
}

export function humanizeTurnError(err: unknown): ClassifiedError {
  const chain = collectCauseChain(err);
  // Concatenated lower-cased text from every layer (name + message + code).
  // The OpenAI SDK wraps the actual transport error 3+ layers deep, AND the
  // persistent-worker dispatcher wraps THAT inside a "(HTTP 500): …" string —
  // so we need to look at everything.
  const text = chain
    .map((e) => {
      const m = (e as Error).message ?? "";
      const n = (e as Error).name ?? "";
      const c = (e as { code?: string }).code ?? "";
      return `${n} ${m} ${c}`;
    })
    .join(" ")
    .toLowerCase();

  // Surface the most-specific HTTP status from anywhere in the chain (the
  // OpenAI SDK puts it on the outer ProviderError; the worker dispatcher
  // bakes it into the wrapper message as "(HTTP 500):").
  const status =
    chain
      .map((e) => (e as { status?: number }).status)
      .find((s): s is number => typeof s === "number") ??
    pickStatusFromText(text);

  // Order matters — check the most specific categories first.

  // 1. Worker container unreachable. Distinct from "the LLM endpoint is down":
  //    if the worker is down, NOTHING the agent does will work. Tell the
  //    operator to look at compose, not at the spark.
  if (/agent worker unreachable|dae-worker.*(?:refused|not reachable)/.test(text)) {
    return {
      category: "worker-down",
      userMessage:
        "I can't reach the agent worker right now. Check `docker compose ps` " +
        "on the host — `dae-worker` should be `running`. " +
        "If it isn't, `docker compose up -d dae-worker` should bring it back. " +
        techHint(text),
    };
  }

  // 2. Context overflow that couldn't be compacted. Distinct error — telling
  //    the user "the upstream is down" here would be actively wrong.
  if (
    /context (?:size|length|window)|context_length_exceeded|exceeds the available context|maximum context|too many tokens|prompt is too long|reduce the (?:length|prompt|number)/.test(
      text,
    )
  ) {
    return {
      category: "context-overflow",
      userMessage:
        "Our conversation got too long for this model's context window, " +
        "and I couldn't compact it any further. Start a fresh thread, or switch " +
        "to a model with a larger context window. " +
        techHint(text),
    };
  }

  // 3. Auth — separate from generic 4xx because the fix is specific.
  if (
    status === 401 ||
    status === 403 ||
    /invalid api key|incorrect api key|unauthorized|forbidden|invalid token|expired token|invalid credentials/.test(
      text,
    )
  ) {
    return {
      category: "auth",
      userMessage:
        "The model endpoint rejected our credentials. " +
        "Check the API key in OneCLI (`dae secret list` to inspect; " +
        "`dae secret save <NAME> -v <new-key>` to rotate). " +
        techHint(text),
    };
  }

  // 4. Rate limit — specifically retryable on a longer cadence than transient.
  if (status === 429 || /rate.?limit|too many requests|quota exceeded/.test(text)) {
    return {
      category: "rate-limit",
      userMessage:
        "The model endpoint is rate-limiting us. Wait a moment, then ask again. " +
        techHint(text),
    };
  }

  // 5. Explicit timeout (the request itself, not a generic connection error).
  if (status === 408 || /\btimed? ?out\b|\btimeout\b|deadline exceeded/.test(text)) {
    return {
      category: "timeout",
      userMessage:
        "The model took too long to respond and timed out. Try again, or use a " +
        "faster model for shorter turns. " +
        techHint(text),
    };
  }

  // 6. Upstream down / unreachable. This is the spark-offline case — the
  //    transport layer reports the connection couldn't be made or the
  //    upstream hung up. We get here AFTER completeWithRetry has exhausted its
  //    retries, so the upstream is genuinely unavailable, not just flapping.
  if (
    (status !== undefined && status >= 500 && status < 600) ||
    /fetch failed|socket(?:error)? (?:hang up|closed)|other side closed|premature close|connection (?:reset|closed|refused|aborted|error)|econnreset|etimedout|econnrefused|econnaborted|epipe|eai_again|und_err|gateway|overload|unavailable|service unavailable/.test(
      text,
    )
  ) {
    return {
      category: "upstream-down",
      userMessage:
        "I couldn't reach the AI model — the upstream is down or hung up on us " +
        "(I tried a few times). " +
        "Check that your model endpoint (OpenAI / LiteLLM / Ollama / …) is up; once it's back, ask me again. " +
        techHint(text),
    };
  }

  // 7. Real bad-request — model name typo, malformed tool schema, etc.
  //    These won't fix themselves; surface enough detail for the operator.
  if (status === 400 || status === 422 || /bad request|invalid (?:model|request|argument)|unprocessable/.test(text)) {
    return {
      category: "bad-request",
      userMessage:
        "The model rejected the request — usually a model-name typo or a " +
        "tool-schema problem. " +
        techHint(text),
    };
  }

  // 8. Unknown — fall back to a short tail so the operator has something to
  //    grep for in the logs without spamming the user with a 500-char stack.
  return {
    category: "unknown",
    userMessage: `Something went wrong on my side. ${techHint(text)}`,
  };
}

// Walk an error and every nested `.cause`, returning the chain. Capped at 8 to
// avoid pathological cycles. Same logic as agent.ts's collectCauseChain —
// duplicated here so this module has no kernel-internal dependency.
function collectCauseChain(err: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = err;
  const seen = new Set<unknown>();
  while (cur && typeof cur === "object" && !seen.has(cur) && out.length < 8) {
    seen.add(cur);
    out.push(cur);
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

// Pull "(HTTP 500)" / "status 503" / "503 service unavailable" out of free-form
// error text — the persistent dispatcher embeds it as a string when it relays
// the worker's 5xx response, so the status property won't always be set.
function pickStatusFromText(text: string): number | undefined {
  const m = /\b(?:http|status)[ :]?(\d{3})\b/.exec(text) ?? /\b(\d{3})\b/.exec(text);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 400 && n < 600 ? n : undefined;
}

// One-line technical hint appended to user messages. Keeps the most specific
// bit of the original error visible (~120 chars) so the sole-operator can
// self-diagnose without checking container logs. Pulled from the lowest level
// of the cause chain — that's where the actual signal lives ("other side
// closed" beats "Connection error.").
function techHint(text: string): string {
  const hint = mostSpecificSignal(text);
  if (!hint) return "";
  return `\n_(technical: ${truncate(hint, 120)})_`;
}

function mostSpecificSignal(text: string): string | undefined {
  // Look for known signals in rough order of specificity.
  const patterns = [
    /(other side closed|premature close|socket hang up|connection (?:reset|closed|refused|aborted))/i,
    /(econnreset|etimedout|econnrefused|econnaborted|epipe|eai_again)/i,
    /(invalid api key|incorrect api key|unauthorized|forbidden)/i,
    /(rate.?limit|too many requests|quota exceeded)/i,
    /(context_length_exceeded|too many tokens|prompt is too long)/i,
    /(bad request|invalid model|invalid argument|unprocessable)/i,
    /(fetch failed)/i,
    /(http \d{3})/i,
  ];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) return m[1];
  }
  return undefined;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
