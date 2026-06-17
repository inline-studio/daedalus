// Smoke for the conversation debug log (feature: per-turn trace for debugging):
//  - append() writes one JSONL record per turn under <dir>/<sessionId>__<date>.jsonl, with the
//    full exchange (tool_use + tool_result) intact;
//  - sessionId is sanitised into the filename;
//  - prune() drops trace files whose mtime is older than retentionDays, keeping fresh ones.

import { mkdtemp, readFile, readdir, utimes, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ConversationLog } from "../dist/sessions/conversation-log.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const dir = await mkdtemp(path.join(os.tmpdir(), "dae-convlog-"));

// 1. append() writes a JSONL record carrying the full exchange.
{
  const log = new ConversationLog(dir, 5);
  const written = await log.append({
    ts: "2026-06-17T10:00:00.000Z",
    agent: "orchestrator",
    sessionId: "sess/abc:1",
    model: "m",
    isSubagent: false,
    turns: 2,
    stopReason: "end_turn",
    usage: { inputTokens: 10, outputTokens: 2 },
    exchange: [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: { cmd: "gh repo view x" } }] },
      { role: "user", content: [{ type: "tool_result", toolUseId: "t1", content: "not found", isError: true }] },
      { role: "assistant", content: [{ type: "text", text: "no such repo" }] },
    ],
    finalText: "no such repo",
  });
  expect("append returns the file path", typeof written === "string" && written.endsWith(".jsonl"));
  // sessionId sanitised: '/' and ':' → '_'
  expect("filename sanitises sessionId + dates it", path.basename(written) === "sess_abc_1__2026-06-17.jsonl", path.basename(written ?? ""));
  const body = await readFile(written, "utf8");
  const rec = JSON.parse(body.trim());
  const toolCall = rec.exchange.find((m) => m.content.some((c) => c.type === "tool_use"));
  expect("record preserves the tool_use (the 'did it run gh?' evidence)", Boolean(toolCall));
  expect("record preserves the tool_result", rec.exchange.some((m) => m.content.some((c) => c.type === "tool_result")));
}

// 2. A second append on the same session/day appends (doesn't overwrite).
{
  const log = new ConversationLog(dir, 5);
  const f = await log.append({
    ts: "2026-06-17T11:00:00.000Z",
    agent: "orchestrator",
    sessionId: "sess/abc:1",
    model: "m",
    isSubagent: false,
    turns: 1,
    stopReason: "end_turn",
    exchange: [{ role: "assistant", content: [{ type: "text", text: "second" }] }],
    finalText: "second",
  });
  const lines = (await readFile(f, "utf8")).trim().split("\n");
  expect("second turn appended (2 lines)", lines.length === 2, `${lines.length} lines`);
}

// 3. prune() drops files older than retentionDays, keeps fresh ones.
{
  // A stale trace file, mtime 10 days ago.
  const stale = path.join(dir, "old__2026-06-01.jsonl");
  await writeFile(stale, "{}\n");
  const tenDaysAgo = new Date("2026-06-07T00:00:00.000Z"); // 10 days before the 17th
  await utimes(stale, tenDaysAgo, tenDaysAgo);

  const log = new ConversationLog(dir, 5);
  await log.prune();

  let staleGone = false;
  try {
    await stat(stale);
  } catch {
    staleGone = true;
  }
  expect("stale trace (>retentionDays) pruned", staleGone);

  const remaining = await readdir(dir);
  expect("fresh trace kept", remaining.includes("sess_abc_1__2026-06-17.jsonl"), remaining.join(","));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
