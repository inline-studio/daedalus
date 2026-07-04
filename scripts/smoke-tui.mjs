// Smoke test for the dae terminal interface's testable core: the LineEditor state
// machine, ANSI-aware truncation, the Screen's reserved-row rendering, and the remote
// profile roundtrip. (The interactive loop itself needs a real TTY; everything that can
// be pure, is.)

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Profile paths derive from HOME at module load — point it at a scratch dir BEFORE import.
process.env.HOME = mkdtempSync(join(tmpdir(), "dae-smoke-tui-home-"));
const { LineEditor, Screen, visibleTruncate } = await import("../dist/cli/tui.js");
const shared = await import("../dist/cli/remote-shared.js");

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const k = (name, extra = {}) => ({ name, sequence: name?.length === 1 ? name : undefined, ...extra });
const type = (ed, text) => { for (const ch of text) ed.handle({ sequence: ch, name: ch }); };

// --- 1. LineEditor ---
{
  const ed = new LineEditor();
  type(ed, "git status");
  expect("typing fills the buffer", ed.buffer === "git status" && ed.cursor === 10);
  ed.handle(k("left"));
  ed.handle(k("left"));
  ed.handle(k("backspace"));
  expect("cursor movement + backspace edit mid-line", ed.buffer === "git staus" && ed.cursor === 7, ed.buffer);
  ed.handle({ name: "a", ctrl: true });
  expect("ctrl-a homes", ed.cursor === 0);
  ed.handle({ name: "e", ctrl: true });
  expect("ctrl-e ends", ed.cursor === ed.buffer.length);
  ed.handle({ name: "w", ctrl: true });
  expect("ctrl-w kills the last word", ed.buffer === "git ", ed.buffer);
  ed.handle({ name: "u", ctrl: true });
  expect("ctrl-u kills to start", ed.buffer === "");

  type(ed, "first");
  const s1 = ed.handle(k("return"));
  type(ed, "second");
  const s2 = ed.handle(k("return"));
  expect("enter submits + clears", s1?.submit === "first" && s2?.submit === "second" && ed.buffer === "");
  type(ed, "draft");
  ed.handle(k("up"));
  expect("up recalls the last entry", ed.buffer === "second");
  ed.handle(k("up"));
  expect("up again goes older", ed.buffer === "first");
  ed.handle(k("down"));
  ed.handle(k("down"));
  expect("down restores the draft", ed.buffer === "draft", ed.buffer);
}

// --- 2. visibleTruncate ---
{
  expect("plain truncation", visibleTruncate("abcdefgh", 5) === "abcde");
  const dim = "\x1b[2mhello world\x1b[0m";
  const cut = visibleTruncate(dim, 5);
  expect("ANSI codes don't count toward width", cut.includes("hello") && !cut.includes("world"));
  expect("a cut styled string still resets", cut.endsWith("\x1b[0m"));
}

// --- 3. Screen reserved-row rendering ---
{
  let outBuf = "";
  const screen = new Screen({ write: (s) => (outBuf += s), columns: () => 40 });
  screen.start();
  outBuf = "";
  screen.setStatus("STATUSLINE");
  expect("status repaint moves up 2 and clears down", outBuf.includes("\x1b[2A") && outBuf.includes("\x1b[0J") && outBuf.includes("STATUSLINE"));

  outBuf = "";
  screen.appendLine("hello scrollback");
  expect("appendLine prints above the reserved rows", outBuf.indexOf("hello scrollback") < outBuf.indexOf("STATUSLINE"));

  outBuf = "";
  screen.setInput("> ", "hello", 3);
  // border "│ " (2) + prompt (2) + cursor (3) + 1 → absolute column 8, inside the box.
  expect(
    "input renders inside the composer box, cursor at the edit column",
    outBuf.includes("\x1b[8G") && outBuf.includes("> hello") && outBuf.includes("╭") && outBuf.includes("╰"),
  );

  // Command palette rows paint ABOVE the composer box (between transcript and input);
  // the cursor climb stays a constant 2 (bottom border + status), and the NEXT repaint's
  // upward anchor accounts for the palette height (2 + 2 rows).
  outBuf = "";
  screen.setMenu(["▸ /new    start a session", "  /help   commands"]);
  const boxTopIdx = outBuf.indexOf("╭");
  expect(
    "palette rows paint above the composer, cursor climbs 2",
    outBuf.indexOf("/new") < boxTopIdx && outBuf.indexOf("/help") < boxTopIdx && outBuf.endsWith("\x1b[2A\x1b[8G"),
    JSON.stringify(outBuf.slice(-40)),
  );
  outBuf = "";
  screen.setMenu([]);
  expect(
    "closing the palette anchors over the old palette rows and repaints without them",
    outBuf.startsWith("\x1b[4A") && !outBuf.includes("/new"),
    JSON.stringify(outBuf.slice(0, 12)),
  );

  outBuf = "";
  screen.setInput("> ", "x".repeat(100), 100);
  expect("overlong input is windowed to the width", !outBuf.includes("x".repeat(60)));

  outBuf = "";
  screen.setConfirm("run: rm -rf /tmp/x  [y]es / [n]o");
  expect("confirm mode replaces the input row", outBuf.includes("run: rm -rf") && !outBuf.includes("> x"));
  screen.setConfirm(null);

  // /clear: wipe + home + re-anchored repaint of the composer block.
  outBuf = "";
  screen.clear();
  expect(
    "clear() wipes the screen and repaints the composer block",
    outBuf.startsWith("\x1b[2J\x1b[H") && outBuf.includes("╭") && outBuf.includes("╰"),
    JSON.stringify(outBuf.slice(0, 16)),
  );
}

// --- 3a. boxify: the welcome-card / composer frame helper ---
{
  const { boxify, visibleLength } = await import("../dist/cli/tui.js");
  const box = boxify(["hello", "\x1b[2mdim line\x1b[0m"], 30, "dae v1");
  expect("boxify draws a rounded titled frame", box[0].includes("╭─ dae v1 ─") && box[box.length - 1].includes("╰"), box[0]);
  expect("boxify pads every row to one width", new Set(box.map((l) => visibleLength(l))).size === 1, JSON.stringify(box.map(visibleLength)));
  expect("styled content keeps its reset inside the frame", box[2].includes("dim line") && box[2].includes("\x1b[0m"));
}

// --- 3b. Command palette filtering ---
{
  const { filterPalette, CLIENT_COMMANDS } = await import("../dist/cli/remote-tui.js");
  expect("bare '/' lists every command", filterPalette(CLIENT_COMMANDS, "/").length === CLIENT_COMMANDS.length);
  const s = filterPalette(CLIENT_COMMANDS, "/s");
  expect(
    "'/s' filters by prefix",
    s.length >= 3 && s.every((e) => e.name.startsWith("/s")),
    JSON.stringify(s.map((e) => e.name)),
  );
  expect("plain text keeps the palette closed", filterPalette(CLIENT_COMMANDS, "hello").length === 0);
  expect("a command with arguments closes the palette", filterPalette(CLIENT_COMMANDS, "/sessions 2").length === 0);
  expect("unknown prefix matches nothing", filterPalette(CLIENT_COMMANDS, "/zzz").length === 0);
}

// --- 4. Profile roundtrip (HOME-scoped) ---
{
  shared.saveProfile({
    url: "https://chat.example.com",
    username: "scott",
    workspace: "/tmp/ws",
    execution: "local",
    approval: "ask",
  });
  const loaded = shared.loadProfile();
  expect("profile persists and reloads", loaded?.url === "https://chat.example.com" && loaded?.approval === "ask", JSON.stringify(loaded));
  const raw = readFileSync(shared.profilePath(), "utf8");
  expect("no password field is ever persisted", !raw.includes("password"));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
