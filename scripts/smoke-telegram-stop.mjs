// BUG-06: TelegramChannel.stop() must abort the in-flight getUpdates long-poll (otherwise
// shutdown hangs up to ~30s) and await the poll loop's exit. We mock global fetch: the
// signal-bearing long-poll hangs until aborted; the no-signal initial drain resolves empty.

import { TelegramChannel } from "../dist/channels/telegram.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

let abortObserved = false;
const realFetch = globalThis.fetch;
globalThis.fetch = (_url, init) => {
  if (init && init.signal) {
    // The long-poll: never resolves until the signal aborts.
    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        abortObserved = true;
        reject(new Error("aborted"));
      };
      if (init.signal.aborted) return onAbort();
      init.signal.addEventListener("abort", onAbort);
    });
  }
  // Initial drain (no signal): resolve with no updates.
  return Promise.resolve({ ok: true, json: async () => ({ ok: true, result: [] }) });
};

try {
  const ch = new TelegramChannel({ defaultAgent: "x", token: "fake-token", allowedChatIds: ["1"] });
  const ctx = { publish: async () => {} };
  await ch.start(ctx);
  // Give the poll loop a tick to enter the hanging long-poll.
  await new Promise((r) => setTimeout(r, 50));

  const t0 = Date.now();
  await ch.stop();
  const elapsed = Date.now() - t0;

  expect("stop() returns promptly (no ~30s long-poll hang)", elapsed < 2000, `elapsed=${elapsed}ms`);
  expect("the in-flight long-poll fetch was aborted", abortObserved);
} finally {
  globalThis.fetch = realFetch;
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
