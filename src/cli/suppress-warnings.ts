// Suppress Node's "ExperimentalWarning: SQLite is an experimental feature"
// noise on every dae invocation. daedalus uses node:sqlite deliberately for
// SessionStore + ScheduleStore — we know it's experimental; the user doesn't
// need to be told every command.
//
// MUST be imported BEFORE anything that transitively loads node:sqlite (and
// before any other stderr writer); we patch process.stderr.write here.
//
// Implementation note: `process.on('warning')` doesn't suppress Node's
// built-in stderr print — it ADDS a listener. Confirmed on Node 24.15.0:
// emitting a warning with our listener attached still produces the default
// "(node:PID) WarningName: …" lines. So we patch stderr.write and filter the
// specific two lines Node emits for the SQLite warning (the header + the
// trace-warnings hint that follows it).
//
// We deliberately do NOT use --disable-warning=ExperimentalWarning at the
// shebang level: it'd be too broad (suppresses every experimental warning
// going forward), and changing the shebang has packaging implications for
// `env -S` portability that we don't want to take on for one warning.

type StderrWrite = typeof process.stderr.write;

const HEADER_RE = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/;
const HINT_RE = /^\(Use `node --trace-warnings/;

let skipNextHint = false;
const orig: StderrWrite = process.stderr.write.bind(process.stderr);

// Re-typed with Function.prototype.call signature so TS accepts the override.
// (process.stderr.write has 3 overloads; we wrap them in a single permissive one.)
process.stderr.write = function patchedWrite(
  this: typeof process.stderr,
  chunk: unknown,
  encodingOrCb?: unknown,
  cb?: unknown,
): boolean {
  const s =
    typeof chunk === "string"
      ? chunk
      : chunk && (chunk as { toString?: () => string }).toString
        ? (chunk as { toString: () => string }).toString()
        : "";
  // Match the SQLite warning header — swallow it AND set a flag so the
  // immediately-following "(Use `node --trace-warnings …`)" hint also gets
  // swallowed. Node always pairs them on the same emit.
  if (HEADER_RE.test(s)) {
    skipNextHint = true;
    return true;
  }
  if (skipNextHint && HINT_RE.test(s)) {
    skipNextHint = false;
    return true;
  }
  // The "skip" flag only protects the very next write — if Node emits anything
  // else in between, reset so we don't accidentally swallow an unrelated hint.
  if (skipNextHint) skipNextHint = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (orig as any).call(process.stderr, chunk, encodingOrCb, cb);
} as unknown as StderrWrite;
