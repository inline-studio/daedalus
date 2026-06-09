// Current-time context. Appended fresh to the latest user turn on every kernel turn so the
// model never falls back to "today" assumptions from training data or stale session state.
// It lives on the user turn rather than the system prompt deliberately: a timestamp baked into
// the system prefix changes every request and forces the inference backend to re-prefill the
// whole prompt cold, whereas a time-invariant system prompt + tool set stays byte-identical and
// its KV cache is reused. See appendNowToLastUserMessage.

import type { Message } from "../types.js";

export interface NowContextOptions {
  // Override the system timezone (e.g. "America/New_York"). Defaults to Intl resolvedOptions.
  timezone?: string;
}

export function nowContext(opts: NowContextOptions = {}): string {
  const now = new Date();
  const tz = opts.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

  const iso = now.toISOString();
  const local = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    dateStyle: "full",
    timeStyle: "long",
  }).format(now);
  const dayOfWeek = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    weekday: "long",
  }).format(now);

  const lines: string[] = [
    "# Now",
    "",
    `- Current date/time (UTC): ${iso}`,
    `- Local time (${tz}): ${local}`,
    `- Day of the week: ${dayOfWeek}`,
  ];

  lines.push(
    "",
    "Treat the values above as authoritative. Do NOT say \"today\" or \"yesterday\" without",
    "checking these. If a prior message in the conversation refers to \"today\", read it as",
    "the timestamp it carries — not as the current date.",
  );

  return lines.join("\n");
}

// Append the time context to the latest user turn, mutating `messages` in place. Replaces the
// last slot with a fresh object (never mutates the original message) and keeps the array length
// unchanged, so callers that slice on `messages.length` to find newly-produced messages stay
// correct and the transient timestamp is never persisted. No-op when not time-aware or when the
// last message isn't a user turn.
export function appendNowToLastUserMessage(
  messages: Message[],
  opts: { timeAware?: boolean; timezone?: string } = {},
): void {
  if (opts.timeAware === false || messages.length === 0) return;
  const last = messages[messages.length - 1]!;
  if (last.role !== "user") return;
  const now = nowContext(opts.timezone ? { timezone: opts.timezone } : {});
  messages[messages.length - 1] = {
    ...last,
    content: [...last.content, { type: "text", text: `\n\n${now}` }],
  };
}

export function formatGap(ms: number): string {
  if (ms < 60_000) return "less than a minute";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const remMin = minutes % 60;
  if (hours < 24) {
    return remMin > 0
      ? `${hours} hour${hours === 1 ? "" : "s"} ${remMin} minute${remMin === 1 ? "" : "s"}`
      : `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return remHours > 0
    ? `${days} day${days === 1 ? "" : "s"} ${remHours} hour${remHours === 1 ? "" : "s"}`
    : `${days} day${days === 1 ? "" : "s"}`;
}
