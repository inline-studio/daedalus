import prompts from "prompts";

// Modern terminals (Ghostty, Kitty, iTerm2, …) ship with focus reporting and
// bracketed-paste mode enabled. While the user is typing into a `prompts({
// type: "password" })` field, alt-tabbing / clicking out of the terminal sends:
//
//   ESC [ I       focus-in
//   ESC [ O       focus-out
//   ESC [ ? 2004h bracketed-paste enable (some terminals re-send on focus changes)
//   ESC [ 200 ~   paste start
//   ESC [ 201 ~   paste end
//
// `prompts` consumes those bytes as user input. The masked display shows extra
// asterisks but the user has no way to delete the underlying chars (the mask
// hides the cursor position relative to the real buffer). Result: secrets get
// junk prefixed/suffixed and authentication fails downstream.
//
// Fix: disable focus reporting + bracketed paste for the duration of the
// prompt, and defensively strip any leftover CSI/escape sequences from the
// captured value before returning. Restore terminal modes after.
export interface SecretPromptOptions {
  message: string;
  initial?: string;
  // Passed through to prompts. Validation runs against the user's typed value
  // (still mask-displayed); the value handed to validate is whatever they typed,
  // pre-sanitization, so reject criteria like length/regex work as the user expects.
  validate?: (value: string) => boolean | string;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// Wire-level control sequences to disable / re-enable while the prompt is open.
const TERM_DISABLE = `${ESC}[?1004l${ESC}[?2004l`;
const TERM_ENABLE = `${ESC}[?1004h${ESC}[?2004h`;

// Built via RegExp constructor so the source file doesn't need literal control
// characters that some toolchains (and `git diff`) handle poorly.
//
//   CSI: ESC [ <params> <final> — final is roughly @–~
//   OSC: ESC ] <payload> BEL    (we also accept ESC \ as terminator)
//   SS3: ESC O <final>           (function-key prefix on some terminals)
//   LONE_CTRL: stray control bytes other than tab / newline / CR.
const CSI = new RegExp(`${escapeRe(ESC)}\\[[\\d;?]*[a-zA-Z~@\`]`, "g");
const OSC = new RegExp(`${escapeRe(ESC)}\\][\\s\\S]*?(?:${escapeRe(BEL)}|${escapeRe(ESC)}\\\\)`, "g");
const SS3 = new RegExp(`${escapeRe(ESC)}O[a-zA-Z~]`, "g");
const LONE_CTRL = new RegExp(
  `[${cc(0x00)}-${cc(0x08)}${cc(0x0b)}${cc(0x0c)}${cc(0x0e)}-${cc(0x1f)}${cc(0x7f)}]`,
  'g',
);

function cc(n: number): string { return String.fromCharCode(n); }

export function sanitizeSecret(raw: string): string {
  return raw
    .replace(OSC, "")
    .replace(CSI, "")
    .replace(SS3, "")
    .replace(LONE_CTRL, "");
}

export async function secretPrompt(opts: SecretPromptOptions): Promise<string | undefined> {
  const isTTY = process.stdout.isTTY === true;
  if (isTTY) {
    try {
      process.stdout.write(TERM_DISABLE);
    } catch {
      // not fatal — sanitization will still clean the result.
    }
  }
  let raw: string | undefined;
  try {
    const promptOpts: {
      type: "password";
      name: "v";
      message: string;
      initial?: string;
      validate?: (v: string) => boolean | string;
    } = {
      type: "password",
      name: "v",
      message: opts.message,
    };
    if (opts.initial !== undefined) promptOpts.initial = opts.initial;
    if (opts.validate) promptOpts.validate = opts.validate;
    const r = await prompts(promptOpts);
    raw = r.v as string | undefined;
  } finally {
    if (isTTY) {
      try {
        process.stdout.write(TERM_ENABLE);
      } catch {
        // ignore — terminal state is the user's problem at this point.
      }
    }
  }
  if (raw === undefined) return undefined;
  return sanitizeSecret(raw);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
