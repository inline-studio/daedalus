// Minimal terminal-UI engine for the `dae remote` interface. Hand-rolled ANSI, no
// dependencies — matching the zero-dep web UI. Two pieces, both testable without a
// real terminal (injectable output + column source):
//
//   LineEditor — a pure input-line state machine: buffer, cursor, history, kill keys.
//     Fed decoded keypress events; returns a submit when Enter lands.
//
//   Screen — scrollback with THREE reserved bottom rows:
//       [ partial ]   the streaming reply's in-progress line, updated in place
//       [ status  ]   the persistent status line
//       [ input   ]   prompt + editor view (or an active confirm question)
//     Output lines are inserted ABOVE the reserved rows (native terminal scrollback
//     keeps working); the bottom is repainted after every change. Status/input/partial
//     are truncated to the terminal width so wrapping can't break the row accounting;
//     scrollback lines may wrap freely (they're printed before the repaint).

export interface Key {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  sequence?: string;
}

// --- LineEditor -------------------------------------------------------------------------

export class LineEditor {
  buffer = "";
  cursor = 0;
  private history: string[] = [];
  private histIdx = -1; // -1 = editing a fresh draft
  private draft = "";

  loadHistory(entries: string[]): void {
    this.history = entries.slice(-200);
  }

  getHistory(): string[] {
    return [...this.history];
  }

  // Handle one key. Returns { submit } when Enter completes a line, null otherwise.
  handle(key: Key): { submit: string } | null {
    const name = key.name ?? "";
    if (name === "return" || name === "enter") {
      const text = this.buffer;
      if (text.trim()) {
        this.history.push(text);
        if (this.history.length > 200) this.history.shift();
      }
      this.buffer = "";
      this.cursor = 0;
      this.histIdx = -1;
      this.draft = "";
      return { submit: text };
    }
    if (name === "backspace") {
      if (this.cursor > 0) {
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor--;
      }
      return null;
    }
    if (name === "delete") {
      this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
      return null;
    }
    if (name === "left") {
      if (this.cursor > 0) this.cursor--;
      return null;
    }
    if (name === "right") {
      if (this.cursor < this.buffer.length) this.cursor++;
      return null;
    }
    if ((key.ctrl && name === "a") || name === "home") {
      this.cursor = 0;
      return null;
    }
    if ((key.ctrl && name === "e") || name === "end") {
      this.cursor = this.buffer.length;
      return null;
    }
    if (key.ctrl && name === "u") {
      this.buffer = this.buffer.slice(this.cursor);
      this.cursor = 0;
      return null;
    }
    if (key.ctrl && name === "w") {
      // Kill the word before the cursor.
      const head = this.buffer.slice(0, this.cursor).replace(/\S+\s*$/, "");
      this.buffer = head + this.buffer.slice(this.cursor);
      this.cursor = head.length;
      return null;
    }
    if (name === "up") {
      if (this.history.length === 0) return null;
      if (this.histIdx === -1) {
        this.draft = this.buffer;
        this.histIdx = this.history.length - 1;
      } else if (this.histIdx > 0) {
        this.histIdx--;
      }
      this.buffer = this.history[this.histIdx] ?? "";
      this.cursor = this.buffer.length;
      return null;
    }
    if (name === "down") {
      if (this.histIdx === -1) return null;
      if (this.histIdx < this.history.length - 1) {
        this.histIdx++;
        this.buffer = this.history[this.histIdx] ?? "";
      } else {
        this.histIdx = -1;
        this.buffer = this.draft;
      }
      this.cursor = this.buffer.length;
      return null;
    }
    // Printable input: a single non-control character (readline gives us `sequence`).
    const seq = key.sequence ?? "";
    if (seq && !key.ctrl && !key.meta && seq >= " " && seq !== "\x7f") {
      this.buffer = this.buffer.slice(0, this.cursor) + seq + this.buffer.slice(this.cursor);
      this.cursor += seq.length;
    }
    return null;
  }
}

// --- Screen -----------------------------------------------------------------------------

const ESC = "\x1b[";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const TEAL = "\x1b[36m";

// Visible length ignoring ANSI colour sequences (for box padding).
export function visibleLength(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

// A rounded teal box around pre-styled content lines (the Claude-Code welcome-card
// look). `title` renders into the top border. Content is padded to the box's inner
// width; overlong lines are truncated.
export function boxify(lines: string[], width: number, title?: string): string[] {
  const inner = Math.max(10, width - 4); // "│ " + " │"
  const top =
    TEAL +
    "╭" +
    (title ? "─ " + title + " " + "─".repeat(Math.max(0, inner - title.length - 1)) : "─".repeat(inner + 2)) +
    "╮" +
    RESET;
  const bottom = TEAL + "╰" + "─".repeat(inner + 2) + "╯" + RESET;
  const body = lines.map((l) => {
    const cut = visibleTruncate(l, inner);
    const pad = " ".repeat(Math.max(0, inner - visibleLength(cut)));
    return TEAL + "│ " + RESET + cut + pad + TEAL + " │" + RESET;
  });
  return [top, ...body, bottom];
}

export interface ScreenOptions {
  write: (s: string) => void;
  columns: () => number;
}

// Truncate to the terminal width, accounting (approximately) for ANSI sequences: the
// visible length ignores escape codes. Good enough for our own dim/reset usage.
export function visibleTruncate(s: string, max: number): string {
  let visible = 0;
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "\x1b") {
      const m = s.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (visible >= max) break;
    out += s[i];
    visible++;
    i++;
  }
  // Never leave the terminal in a dim/coloured state after a cut.
  return out + (out.includes("\x1b[") ? RESET : "");
}

export class Screen {
  private partial = "";
  private status = "";
  private prompt = "> ";
  private inputView = { text: "", cursor: 0 };
  // Confirm mode replaces the input row with a question until answered.
  private confirmText: string | null = null;
  // Command-palette rows rendered BELOW the input (pre-styled; one terminal row each).
  private menu: string[] = [];
  private started = false;

  constructor(private opts: ScreenOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    // Reserve the three bottom rows (partial, status, input); cursor parks on input.
    this.opts.write("\n\n");
    this.redraw();
  }

  // A finished scrollback line (may wrap freely). Clears the reserved rows, prints the
  // line where the partial row was, then repaints the bottom.
  appendLine(text: string): void {
    this.opts.write(`${ESC}2A\r${ESC}0J` + text + "\n");
    this.paintBottomTail();
  }

  setPartial(text: string): void {
    this.partial = text;
    this.redraw();
  }

  setStatus(text: string): void {
    this.status = text;
    this.redraw();
  }

  setInput(prompt: string, text: string, cursor: number): void {
    this.prompt = prompt;
    this.inputView = { text, cursor };
    this.redraw();
  }

  setConfirm(question: string | null): void {
    this.confirmText = question;
    this.redraw();
  }

  // Replace the palette rows (empty array = closed). The cursor stays parked on the
  // input row; the rows paint below it.
  setMenu(lines: string[]): void {
    this.menu = lines;
    this.redraw();
  }

  // Full repaint of the reserved block. Row order (top → bottom):
  //   [ partial   ]  the streaming reply's in-progress line
  //   [ ╭────────╮]  composer top border (teal, Claude-Code style)
  //   [ │ > input│]  the edit row — the cursor parks HERE
  //   [ ╰────────╯]  composer bottom border
  //   [ status    ]  the persistent status line (under the box, like the reference)
  //   [ palette…  ]  command-palette rows while open
  // The cursor sits on the input row, always 2 rows below the partial row, so the
  // upward anchor is a constant `2A` and `0J` wipes everything below in one go.
  redraw(): void {
    if (!this.started) return;
    this.opts.write(`${ESC}2A\r${ESC}0J`);
    this.paintBottomTail();
  }

  private paintBottomTail(): void {
    const cols = Math.max(20, this.opts.columns());
    const partial = visibleTruncate(this.partial, cols - 1);
    const status = visibleTruncate(this.status, cols - 1);
    const inner = cols - 4; // box interior: "│ " + " │"
    const boxTop = TEAL + "╭" + "─".repeat(inner + 2) + "╮" + RESET;
    const boxBottom = TEAL + "╰" + "─".repeat(inner + 2) + "╯" + RESET;
    let content: string;
    let cursorCol: number; // 1-based terminal column to park the cursor at
    if (this.confirmText !== null) {
      content = visibleTruncate(this.confirmText, inner);
      cursorCol = 2 + visibleLength(content) + 1;
    } else {
      // Show the tail of the buffer when it exceeds the width (simple horizontal scroll).
      const avail = inner - this.prompt.length;
      let text = this.inputView.text;
      let cursor = this.inputView.cursor;
      if (text.length > avail) {
        const start = Math.max(0, Math.min(text.length - avail, cursor - Math.floor(avail / 2)));
        text = text.slice(start, start + avail);
        cursor = cursor - start;
      }
      content = this.prompt + text;
      cursorCol = 2 + this.prompt.length + cursor + 1;
    }
    const pad = " ".repeat(Math.max(0, inner - visibleLength(content)));
    const inputRow = TEAL + "│ " + RESET + content + pad + TEAL + " │" + RESET;
    let out = partial + "\n" + boxTop + "\n" + inputRow + "\n" + boxBottom + "\n" + status;
    for (const row of this.menu) out += "\n" + visibleTruncate(row, cols - 1);
    this.opts.write(out);
    // Park the cursor back on the input row: up over the palette rows, the status
    // line, and the bottom border, then absolute column.
    this.opts.write(`${ESC}${2 + this.menu.length}A${ESC}${cursorCol}G`);
  }
}

export { DIM, RESET };
