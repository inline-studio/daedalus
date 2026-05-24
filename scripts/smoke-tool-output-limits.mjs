// Smoke for right-sized tool output: a single tool result can no longer dump an
// unbounded blob into the conversation. `read` pages by line + caps chars, `bash`
// caps each stream, and `capChars` (used by web_fetch) bounds output.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readTool } from "../dist/tools/file.js";
import { bashTool } from "../dist/tools/bash.js";
import {
  capChars,
  WEB_FETCH_MAX_CHARS,
  BASH_STREAM_MAX_CHARS,
  READ_DEFAULT_LINES,
  READ_MAX_CHARS,
} from "../dist/tools/limits.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const tmpFiles = [];
const mkTmp = (contents) => {
  const p = path.join(os.tmpdir(), `dae-limits-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  fs.writeFileSync(p, contents);
  tmpFiles.push(p);
  return p;
};

// 1. read pages by line: default returns the first READ_DEFAULT_LINES, with a continue hint.
{
  const file = mkTmp(Array.from({ length: 2000 }, (_, i) => `line ${i + 1}`).join("\n"));
  const r1 = await readTool.invoke({ path: file }, {});
  expect(
    "default read returns the first page only",
    r1.content.includes("line 1\n") &&
      r1.content.includes(`line ${READ_DEFAULT_LINES}`) &&
      !r1.content.includes("line 1001"),
  );
  expect("default read hints how to continue", /offset=1001 for more/.test(r1.content));

  // 2. paging with offset returns the rest, no further hint at EOF.
  const r2 = await readTool.invoke({ path: file, offset: 1001 }, {});
  expect(
    "offset read returns the remaining lines",
    r2.content.includes("line 1001") && r2.content.includes("line 2000") && !r2.content.includes("offset="),
  );
}

// 3. read char-cap: one giant line is cut hard with a "narrow your read" note.
{
  const file = mkTmp("X".repeat(150_000));
  const r = await readTool.invoke({ path: file }, {});
  expect(
    "read caps a huge single line",
    r.content.length <= READ_MAX_CHARS + 200 && /re-read with a smaller limit/.test(r.content),
    `len=${r.content.length}`,
  );
}

// 4. bash caps each stream.
{
  const fakeRuntime = {
    id: "host",
    async exec() {
      return { stdout: "a".repeat(60_000), stderr: "b".repeat(60_000), exitCode: 0, timedOut: false };
    },
  };
  const res = await bashTool.invoke({ command: "noop" }, { runtime: fakeRuntime, workspacePath: "/tmp" });
  // Each stream is capped, so total stays bounded well under the old 2×30k.
  expect(
    "bash truncates oversized output",
    res.content.includes("[truncated") && res.content.length < 2 * BASH_STREAM_MAX_CHARS + 500,
    `len=${res.content.length}`,
  );
}

// 5. capChars (web_fetch path) bounds output and leaves small content untouched.
{
  const big = capChars("z".repeat(WEB_FETCH_MAX_CHARS + 5_000), WEB_FETCH_MAX_CHARS);
  const small = capChars("hello", WEB_FETCH_MAX_CHARS);
  expect(
    "capChars truncates over the cap",
    big.length <= WEB_FETCH_MAX_CHARS + 80 && big.includes("[truncated"),
    `len=${big.length}`,
  );
  expect("capChars leaves small content alone", small === "hello");
}

for (const f of tmpFiles) {
  try {
    fs.unlinkSync(f);
  } catch {
    /* best effort */
  }
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
