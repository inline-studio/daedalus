// Smoke for the process-wide terminal-mode toggle that protects ALL prompts()
// calls from terminal focus / bracketed-paste escape sequence injection.

import { installCliTerminalModes, _resetCliTerminalModesForTests } from "../dist/cli/terminal-modes.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// Capture writes to stdout so we can assert the disable codes get sent on
// install and the enable codes get sent on exit. The capture restore is in
// finally so we can still log assertion output afterwards.
function captureStdout(fn) {
  const buf = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    buf.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf.join("");
}

const DISABLE = "\x1b[?1004l\x1b[?2004l";
const ENABLE = "\x1b[?1004h\x1b[?2004h";

// 1. With a TTY, install writes the disable codes.
{
  _resetCliTerminalModesForTests();
  // Force isTTY=true on stdout for this assertion. The harness runs this
  // script with a piped stdout (.isTTY === false) so we mock it.
  const orig = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const out = captureStdout(() => installCliTerminalModes());
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: orig });
  expect(
    "isTTY=true: disable codes written to stdout",
    out === DISABLE,
    `wrote: ${JSON.stringify(out)}`,
  );
}

// 2. Calling install twice is a no-op (no second disable write, exit handlers
// not double-registered).
{
  _resetCliTerminalModesForTests();
  const orig = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  installCliTerminalModes();
  const out2 = captureStdout(() => installCliTerminalModes());
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: orig });
  expect(
    "install is idempotent: second call writes nothing",
    out2 === "",
    `wrote: ${JSON.stringify(out2)}`,
  );
}

// 3. Without a TTY (piped/CI), install is a no-op — no escape codes leak into
// downstream consumers of the output.
{
  _resetCliTerminalModesForTests();
  const orig = process.stdout.isTTY;
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  const out = captureStdout(() => installCliTerminalModes());
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: orig });
  expect(
    "isTTY=false: install writes nothing",
    out === "",
    `wrote: ${JSON.stringify(out)}`,
  );
}

// 4. End-to-end: invoking `dae --help` (which doesn't prompt) on a piped stdout
// must NOT emit the escape sequences into the captured output — the install is
// gated on isTTY, so help output stays plain text.
{
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync("node", ["dist/index.js", "--help"], { encoding: "utf8" });
  const combined = (r.stdout ?? "") + (r.stderr ?? "");
  expect(
    "dae --help on a piped stdout emits no escape codes",
    !combined.includes(DISABLE) && !combined.includes(ENABLE) && !/\x1b\[\?(1004|2004)[hl]/.test(combined),
    `looking for absence of escape codes in ${combined.length}B`,
  );
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
