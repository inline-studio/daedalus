// Smoke for the step-based wizard shell. Drives it directly without going
// through any real setup, so we can assert the visible structure without
// needing prompts/network/etc.

import { WizardShell } from "../dist/setup/wizard-shell.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

async function captureStdout(fn) {
  const buf = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    buf.push(typeof chunk === "string" ? chunk : chunk.toString());
    return true;
  };
  try {
    await fn();
  } finally {
    process.stdout.write = orig;
  }
  return buf.join("");
}

const planned = [
  { id: "alpha", title: "Alpha thing" },
  { id: "beta",  title: "Beta thing"  },
  { id: "gamma", title: "Gamma thing" },
];

// Force isTTY=false for deterministic output (no ANSI clear/colour codes).
const origIsTTY = process.stdout.isTTY;
Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });

// 1. step() records outcomes for the summary.
{
  const w = new WizardShell("Test wizard", planned);
  const out = await captureStdout(async () => {
    await w.step("alpha", "Alpha thing", async (record) => {
      record("did the first thing");
      record("did the second thing");
    });
    w.skip("beta", "Beta thing", "user said no");
    await w.step("gamma", "Gamma thing", async (record) => {
      record("ran the gamma");
    });
    w.finish(["run dae serve to start"]);
  });
  expect(
    "non-TTY: step dividers present in output",
    /step 1\/3 — Alpha thing/.test(out) && /step 3\/3 — Gamma thing/.test(out),
    `out: ${out.slice(0, 300)}`,
  );
  expect("alpha recorded as done", w.results[0].status === "done");
  expect("alpha has both bullets", w.results[0].outcomeLines.length === 2);
  expect("beta recorded as skipped", w.results[1].status === "skipped");
  expect("beta skip reason recorded", w.results[1].outcomeLines[0] === "user said no");
  expect("gamma recorded as done", w.results[2].status === "done");
  expect(
    "summary screen lists all three with marks (✓/–/✓ in our case)",
    /✓.*Alpha thing/.test(out) && /–.*Beta thing/.test(out) && /✓.*Gamma thing/.test(out),
    `out: ${out.slice(out.length - 600)}`,
  );
  expect(
    "Next-steps section present in summary",
    /Next\b/.test(out) && /run dae serve/.test(out),
    `out: ${out.slice(out.length - 400)}`,
  );
}

// 2. A failing step lands as status='failed' with the error in the summary.
{
  const w = new WizardShell("Test wizard", planned);
  const out = await captureStdout(async () => {
    try {
      await w.step("alpha", "Alpha thing", async () => {
        throw new Error("boom");
      });
    } catch {
      /* expected */
    }
    w.finish();
  });
  expect("failed step marked failed", w.results[0].status === "failed");
  expect(
    "failure error surfaced in summary",
    /error:.*boom/.test(out),
    `out: ${out.slice(out.length - 400)}`,
  );
}

// 3. step throwing "cancelled" is treated as a skip (matching the existing
// setup wizards' convention).
{
  const w = new WizardShell("Test wizard", planned);
  await captureStdout(async () => {
    try {
      await w.step("alpha", "Alpha thing", async () => {
        throw new Error("cancelled");
      });
    } catch {
      /* expected — caller (runSetupAll) handles it */
    }
  });
  expect("'cancelled' is mapped to status='skipped'", w.results[0].status === "skipped");
}

// 4. TTY path: writes the clear-screen + cursor-home ANSI sequence between
// steps. We don't assert exact bytes since the rendering text is incidental;
// just that the clear codes appear.
{
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
  const w = new WizardShell("Test wizard", planned);
  const out = await captureStdout(async () => {
    await w.step("alpha", "Alpha", async () => {});
    w.finish();
  });
  Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: false });
  expect(
    "TTY path writes ANSI clear+home sequence at step start and finish",
    out.includes("[2J[H"),
    `escape codes were not in the output: ${JSON.stringify(out.slice(0, 200))}`,
  );
}

Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: origIsTTY });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
