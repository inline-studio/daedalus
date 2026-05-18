// Step-based shell that wraps multi-stage wizards (`dae install`,
// `dae setup`). On TTY:
//   - clears the screen before each step
//   - prints a "Step N/M — title" header
//   - lets the step write whatever it wants (existing setup wizards stay as-is)
//   - collects a one-line outcome per step
//   - finishes with a single summary screen ("✓ OneCLI, ✓ MemPalace, …" + next-steps)
//
// Off TTY (CI, piped output): no clears, no ANSI; falls back to linear
// dividers so logs remain readable in captured output.

import os from "node:os";

const ESC = String.fromCharCode(0x1b);
const CLEAR_AND_HOME = `${ESC}[2J${ESC}[H`;
const BOLD = `${ESC}[1m`;
const DIM = `${ESC}[2m`;
const GREEN = `${ESC}[32m`;
const YELLOW = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

export interface WizardStepRecord {
  id: string;
  title: string;
  status: "skipped" | "done" | "failed";
  outcomeLines: string[]; // bullets shown under the step in the final summary
  error?: string;
}

export interface WizardRecordFn {
  (line: string): void;
}

export class WizardShell {
  readonly results: WizardStepRecord[] = [];
  private current: WizardStepRecord | null = null;
  private readonly total: number;
  private completed = 0;
  private readonly isTTY = process.stdout.isTTY === true;

  constructor(
    private readonly title: string,
    plannedSteps: Array<{ id: string; title: string }>,
  ) {
    this.total = plannedSteps.length;
  }

  // Start a new step. Clears screen (TTY) or prints a divider (non-TTY), shows
  // the step header, then yields to `fn` to run whatever the step needs.
  // `fn` receives a `record(line)` callback — anything it records lands in the
  // final summary as a bullet under this step.
  async step<T>(
    id: string,
    title: string,
    fn: (record: WizardRecordFn) => Promise<T>,
  ): Promise<T | null> {
    this.completed++;
    this.current = {
      id,
      title,
      status: "done",
      outcomeLines: [],
    };
    this.renderHeader(this.completed, title);
    const record: WizardRecordFn = (line) => {
      this.current?.outcomeLines.push(line);
    };
    try {
      const result = await fn(record);
      this.current.status = "done";
      this.results.push(this.current);
      return result;
    } catch (err) {
      const msg = (err as Error).message;
      if (msg === "cancelled") {
        this.current.status = "skipped";
      } else {
        this.current.status = "failed";
        this.current.error = msg;
      }
      this.results.push(this.current);
      throw err;
    } finally {
      this.current = null;
    }
  }

  // Mark a step skipped without running it (user said "skip this one"). Records
  // an entry so the summary shows what was skipped vs. what wasn't asked about.
  skip(id: string, title: string, reason?: string): void {
    this.completed++;
    const rec: WizardStepRecord = {
      id,
      title,
      status: "skipped",
      outcomeLines: reason ? [reason] : [],
    };
    this.results.push(rec);
  }

  // Final summary screen. Clears (TTY) and prints what was done + a Next steps
  // block. The setup wizard's normal in-step output is gone by this point;
  // anything important should have been .recorded.
  finish(nextSteps: string[] = []): void {
    if (this.isTTY) process.stdout.write(CLEAR_AND_HOME);
    const banner = `${BOLD}${this.title} — complete${RESET}`;
    println(banner);
    println(dim("─".repeat(60)));
    println("");
    for (const r of this.results) {
      const mark =
        r.status === "done"
          ? `${GREEN}✓${RESET}`
          : r.status === "skipped"
            ? `${YELLOW}–${RESET}`
            : `${RED}✗${RESET}`;
      println(`  ${mark} ${BOLD}${r.title}${RESET}`);
      for (const line of r.outcomeLines) println(`      ${dim("•")} ${line}`);
      if (r.error) println(`      ${RED}error:${RESET} ${r.error}`);
    }
    if (nextSteps.length > 0) {
      println("");
      println(`${BOLD}Next${RESET}`);
      for (const ns of nextSteps) println(`  ${ns}`);
    }
    println("");
  }

  private renderHeader(n: number, title: string): void {
    if (this.isTTY) {
      process.stdout.write(CLEAR_AND_HOME);
      const head = `${BOLD}${this.title}${RESET} ${dim(`— step ${n}/${this.total}`)}`;
      const sub = `${BOLD}${title}${RESET}`;
      println(head);
      println(sub);
      println(dim("─".repeat(60)));
      println("");
    } else {
      // Non-TTY: dividers so captured logs stay legible.
      println("");
      println(`──── ${this.title}: step ${n}/${this.total} — ${title} ────${os.EOL}`);
    }
  }
}

function println(s: string): void {
  process.stdout.write(s + "\n");
}

function dim(s: string): string {
  return process.stdout.isTTY ? `${DIM}${s}${RESET}` : s;
}
