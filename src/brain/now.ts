// Current-time context. Injected fresh into the system prompt on every kernel turn so the
// model never falls back to "today" assumptions from training data or stale session state.

export interface NowContextOptions {
  // Override the system timezone (e.g. "America/New_York"). Defaults to Intl resolvedOptions.
  timezone?: string;
  // Optional: how long since the user last interacted in this session.
  sessionGapMs?: number;
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

  if (opts.sessionGapMs && opts.sessionGapMs > 60_000) {
    lines.push(`- Time since last message in this session: ${formatGap(opts.sessionGapMs)}`);
  }

  lines.push(
    "",
    "Treat the values above as authoritative. Do NOT say \"today\" or \"yesterday\" without",
    "checking these. If a prior message in the conversation refers to \"today\", read it as",
    "the timestamp it carries — not as the current date.",
  );

  return lines.join("\n");
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
