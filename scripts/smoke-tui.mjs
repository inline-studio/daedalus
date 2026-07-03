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
  const backIdx = outBuf.lastIndexOf("\x1b[2D");
  expect("input cursor positions via backward moves", backIdx !== -1 && outBuf.includes("> hello"));

  outBuf = "";
  screen.setInput("> ", "x".repeat(100), 100);
  expect("overlong input is windowed to the width", !outBuf.includes("x".repeat(60)));

  outBuf = "";
  screen.setConfirm("run: rm -rf /tmp/x  [y]es / [n]o");
  expect("confirm mode replaces the input row", outBuf.includes("run: rm -rf") && !outBuf.includes("> x"));
  screen.setConfirm(null);
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
