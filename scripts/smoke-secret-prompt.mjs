// Smoke for the secret-prompt sanitizer.
//
// We can't easily script the interactive prompt itself, but we CAN feed the
// same sequences that terminals inject during focus-in/out and bracketed-paste
// transitions and confirm the sanitizer strips them while leaving the real key
// intact.

import { sanitizeSecret } from "../dist/setup/secret-prompt.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// 1. Plain string passes through unchanged.
expect("plain string unchanged", sanitizeSecret("oc_abc123") === "oc_abc123");

// 2. Focus-out / focus-in CSI sequences get stripped.
const withFocus = `oc_${ESC}[I${ESC}[Oabc123${ESC}[I`;
expect(
  "focus CSI sequences stripped",
  sanitizeSecret(withFocus) === "oc_abc123",
  `got: ${JSON.stringify(sanitizeSecret(withFocus))}`,
);

// 3. Bracketed-paste markers stripped.
const withPaste = `${ESC}[200~oc_abc123${ESC}[201~`;
expect(
  "bracketed-paste markers stripped",
  sanitizeSecret(withPaste) === "oc_abc123",
  `got: ${JSON.stringify(sanitizeSecret(withPaste))}`,
);

// 4. Mouse-tracking enable/disable sequences with ? parameters.
const withMouse = `${ESC}[?1004h${ESC}[?1004loc_abc${ESC}[?2004h123${ESC}[?2004l`;
expect(
  "mouse/focus mode-change sequences stripped",
  sanitizeSecret(withMouse) === "oc_abc123",
  `got: ${JSON.stringify(sanitizeSecret(withMouse))}`,
);

// 5. OSC sequence (window title set) with BEL terminator.
const withOsc = `${ESC}]0;Terminal Title${BEL}oc_abc123`;
expect(
  "OSC + BEL terminator stripped",
  sanitizeSecret(withOsc) === "oc_abc123",
  `got: ${JSON.stringify(sanitizeSecret(withOsc))}`,
);

// 6. Lone C0 control bytes (NUL, BS, DEL).
const withCtrl = `oc_${String.fromCharCode(0x00)}abc${String.fromCharCode(0x08)}123${String.fromCharCode(0x7f)}`;
expect(
  "lone C0 / DEL control bytes stripped",
  sanitizeSecret(withCtrl) === "oc_abc123",
  `got: ${JSON.stringify(sanitizeSecret(withCtrl))}`,
);

// 7. Tabs and embedded newlines should NOT be stripped (could legitimately be
// in a multi-line secret, though unusual). The sanitizer specifically excludes
// 0x09 / 0x0A / 0x0D from the lone-control range.
expect(
  "tab character preserved",
  sanitizeSecret("foo\tbar") === "foo\tbar",
  `got: ${JSON.stringify(sanitizeSecret("foo\tbar"))}`,
);

// 8. SS3 function-key sequences.
const withSs3 = `oc_${ESC}OPabc${ESC}OQ123`;
expect(
  "SS3 function-key sequences stripped",
  sanitizeSecret(withSs3) === "oc_abc123",
  `got: ${JSON.stringify(sanitizeSecret(withSs3))}`,
);

// 9. Realistic mixed-noise input as a Ghostty user would see when alt-tabbing
// twice mid-entry of an API key.
const realistic = `oc_${ESC}[O${ESC}[I${ESC}[200~${ESC}[201~b0169048${ESC}[O${ESC}[I8454`;
expect(
  "realistic Ghostty alt-tab noise stripped, key intact",
  sanitizeSecret(realistic) === "oc_b01690488454",
  `got: ${JSON.stringify(sanitizeSecret(realistic))}`,
);

// 10. secretPrompt must NOT write terminal-mode toggle codes. Toggling here used
// to undo the process-wide disable from installCliTerminalModes(), which then
// caused every NON-secret prompt that ran after a secret one to be vulnerable
// to focus/paste injection again (symptom: `initial` value of the next text
// prompt got clobbered with garbage characters). Lock that bug out.
{
  const src = await import("node:fs").then((m) =>
    m.readFileSync("dist/setup/secret-prompt.js", "utf8"),
  );
  // Look for the specific re-enable sequence the buggy version wrote — it was
  // `\x1b[?1004h\x1b[?2004h` in a template literal, so the compiled JS contains
  // either the raw escape byte or the explicit hex/unicode escape.
  const hasReenable = /\\u001b\[\?1004h|\\x1b\[\?1004h|\[\?1004h/.test(src) ||
    /\\u001b\[\?2004h|\\x1b\[\?2004h|\[\?2004h/.test(src);
  expect(
    "secret-prompt.js does not contain a terminal-mode RE-ENABLE write",
    !hasReenable,
    `re-enable code still present — would break installCliTerminalModes()'s global disable`,
  );
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
