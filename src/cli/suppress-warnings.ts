// Suppress Node's "ExperimentalWarning: SQLite is an experimental feature"
// noise on every dae invocation. daedalus uses node:sqlite deliberately for
// SessionStore + ScheduleStore — we know it's experimental; the user doesn't
// need to be told every command.
//
// TWO LAYERS, because Node's warning path isn't uniform:
//
//   1. Primary — shebang flag `--disable-warning=ExperimentalWarning` in
//      src/index.ts. This is what actually works on Node 24.14, where the
//      warning is emitted from C++ via a path that bypasses user-space
//      process.stderr.write (confirmed empirically: instrumenting write()
//      shows the warning never arrives at the JS layer). The shebang only
//      applies when `dae` is executed via its shebang line, not when
//      someone runs `node dist/index.js` directly.
//
//   2. Fallback — this module patches process.stderr.write to filter the
//      same warning header + the trace-warnings hint that follows it.
//      Catches the case where (a) the shebang was bypassed AND (b) the
//      runtime version DOES write warnings through user-space stderr.
//      Tested working on at least Node 24.15.
//
// Either layer alone closes the loop on its respective Node version. Together
// they cover both code paths.
//
// `process.on('warning')` is NOT a solution — it ADDS a listener, doesn't
// suppress Node's default print. Confirmed on every Node 24.x.

type StderrWrite = typeof process.stderr.write;

const HEADER_RE = /^\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/;
const HINT_RE = /^\(Use `node --trace-warnings/;

// --verbose mode (DAE_VERBOSE=1, set early in src/index.ts before this module
// loads) skips the suppression entirely. The intent of verbose is "tell me
// everything Node has to say," which includes this warning.
const VERBOSE = process.env.DAE_VERBOSE === "1";

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
  // Verbose: write everything through unchanged.
  if (VERBOSE) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (orig as any).call(process.stderr, chunk, encodingOrCb, cb);
  }
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
