// Process-wide protection against terminal focus / bracketed-paste sequences
// leaking into prompt input.
//
// Problem: modern terminals (Ghostty, Kitty, iTerm2, …) send escape sequences
// for focus-in / focus-out / paste-mode transitions as raw bytes on stdin
// (ESC [ I, ESC [ O, ESC [ 200 ~, ESC [ 201 ~, …). When the prompts library is
// awaiting a keypress, those bytes get dispatched to its keypress handler with
// `str` and `key.name` undefined — and the confirm-prompt code path calls
// `.toLowerCase()` on undefined and crashes:
//
//   TypeError: Cannot read properties of undefined (reading 'toLowerCase')
//     at ConfirmPrompt._ (.../prompts/lib/elements/confirm.js:60:11)
//
// We can't fix prompts upstream from here, but we CAN tell the terminal not to
// send those events in the first place for the lifetime of the dae process.
// Same disable codes the per-prompt secretPrompt wrapper uses, applied globally.
// Restored on every plausible exit path so the user's shell goes back to normal.
const ESC = String.fromCharCode(0x1b);
const DISABLE = `${ESC}[?1004l${ESC}[?2004l`; // focus-off + bracketed-paste-off
const ENABLE = `${ESC}[?1004h${ESC}[?2004h`;

let installed = false;

export function installCliTerminalModes(): void {
  if (installed) return;
  if (process.stdout.isTTY !== true) return; // CI, piped output, etc.
  installed = true;
  try {
    process.stdout.write(DISABLE);
  } catch {
    return; // best-effort; don't gum up startup on a stdout write failure
  }
  // Restore on every exit path we can hook. exit handlers are SYNC by design.
  const restore = (): void => {
    try {
      process.stdout.write(ENABLE);
    } catch {
      /* terminal is gone; nothing we can do */
    }
  };
  process.on("exit", restore);
  // For signals, re-emit AFTER restore so the parent shell sees the expected
  // exit status. Otherwise Ctrl-C just shows the user a prompt with focus
  // reporting still disabled in their next shell command.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      restore();
      process.exit(128 + signalNumber(sig));
    });
  }
  process.on("uncaughtException", (err) => {
    restore();
    // re-throw so default behaviour (printing + non-zero exit) still happens
    console.error(err);
    process.exit(1);
  });
}

function signalNumber(sig: "SIGINT" | "SIGTERM" | "SIGHUP"): number {
  switch (sig) {
    case "SIGHUP":  return 1;
    case "SIGINT":  return 2;
    case "SIGTERM": return 15;
  }
}

// Test seam — flips the guard so a smoke test can install twice with state checks.
export function _resetCliTerminalModesForTests(): void {
  installed = false;
}
