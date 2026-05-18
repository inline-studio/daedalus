import { Cron } from "croner";

// Parse the schedule_message tool's `when` argument into a (firstDueAt, recurringCron)
// pair. The agent can hand us:
//   - "in 30 minutes" / "in 2 hours" / "in 1 day"  (one-shot relative)
//   - ISO timestamp                                  (one-shot absolute)
//   - cron expression                                (recurring)
//
// Returns `{ dueAt }` for one-shot or `{ dueAt, cron }` for recurring (dueAt is
// the *first* fire computed from the cron). Throws with a helpful message on
// anything we can't parse — better to error at enqueue than at fire time.
export interface ParsedWhen {
  dueAt: string; // ISO
  cron?: string;
}

const RELATIVE = /^\s*in\s+(\d+(?:\.\d+)?)\s+(second|seconds|sec|secs|s|minute|minutes|min|mins|m|hour|hours|hr|hrs|h|day|days|d)\s*$/i;

export function parseWhen(input: string, now: Date = new Date()): ParsedWhen {
  if (!input || typeof input !== "string") {
    throw new Error("schedule_message: 'when' is required");
  }
  const trimmed = input.trim();

  // Relative: "in N units"
  const rel = trimmed.match(RELATIVE);
  if (rel) {
    const amount = parseFloat(rel[1]!);
    const unit = rel[2]!.toLowerCase();
    const ms = amount * unitToMs(unit);
    if (ms < 1000) throw new Error("schedule_message: minimum delay is 1 second");
    return { dueAt: new Date(now.getTime() + ms).toISOString() };
  }

  // ISO timestamp
  if (looksIso(trimmed)) {
    const date = new Date(trimmed);
    if (Number.isNaN(date.getTime())) {
      throw new Error(`schedule_message: unparseable ISO timestamp: ${trimmed}`);
    }
    if (date.getTime() <= now.getTime()) {
      throw new Error("schedule_message: ISO timestamp must be in the future");
    }
    return { dueAt: date.toISOString() };
  }

  // Cron expression (5- or 6-field). croner handles validation + next-fire.
  try {
    // paused: true so we don't actually arm a job — we just want next().
    const job = new Cron(trimmed, { paused: true }, () => {});
    const next = job.nextRun(now);
    job.stop();
    if (!next) {
      throw new Error("cron expression has no future fire time");
    }
    return { dueAt: next.toISOString(), cron: trimmed };
  } catch (err) {
    throw new Error(
      `schedule_message: 'when' must be "in N minutes/hours/days", an ISO timestamp, ` +
        `or a cron expression. Got: ${trimmed}. (${(err as Error).message})`,
    );
  }
}

// Compute the next fire for a recurring cron. Used by the poll loop after each fire.
export function nextCronFire(cron: string, after: Date = new Date()): string {
  const job = new Cron(cron, { paused: true }, () => {});
  const next = job.nextRun(after);
  job.stop();
  if (!next) throw new Error(`cron ${cron} has no future fire`);
  return next.toISOString();
}

function unitToMs(unit: string): number {
  switch (unit) {
    case "s": case "sec": case "secs": case "second": case "seconds":
      return 1000;
    case "m": case "min": case "mins": case "minute": case "minutes":
      return 60_000;
    case "h": case "hr": case "hrs": case "hour": case "hours":
      return 3_600_000;
    case "d": case "day": case "days":
      return 86_400_000;
    default:
      throw new Error(`unknown time unit: ${unit}`);
  }
}

function looksIso(s: string): boolean {
  // YYYY-MM-DD or YYYY-MM-DDTHH:MM(:SS)?(Z|±HH:MM)?
  return /^\d{4}-\d{2}-\d{2}([Tt ].*)?$/.test(s);
}
