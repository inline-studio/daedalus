// Smoke for reactive auto-compaction: on a real "context exceeded" error the kernel
// summarises the older history into a synopsis, keeps recent turns, retries, and surfaces
// a user-facing notice. Summariser failure falls back to dropping (never blocks a turn).
// No hardcoded context size anywhere — it triggers on the provider's actual overflow.

import { Kernel } from "../dist/kernel/agent.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const okMsg = { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, stopReason: "end_turn" };
const overflow = () =>
  new Error("400 litellm.BadRequestError - request (81302 tokens) exceeds the available context size (65536 tokens)");
const isSummaryReq = (req) => req.system.includes("compress conversation history");

function makeKernel(provider) {
  return new Kernel({
    provider,
    model: "test",
    system: "s",
    builtinTools: [],
    mcpServers: new Map(),
    toolContext: {},
    maxTurns: 5,
    maxTokens: 100,
  });
}

function history(n) {
  const msgs = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `m${i}` }] });
  }
  return msgs;
}

// 1. Overflow → summarise older → retry succeeds; exactly one summary call; notice surfaced.
{
  let summarizeCalls = 0;
  let mainCalls = 0;
  const provider = {
    id: "fake",
    capabilities: {},
    async complete(req) {
      if (isSummaryReq(req)) {
        summarizeCalls++;
        return {
          message: { role: "assistant", content: [{ type: "text", text: "SUMMARY: user asked about widgets; chose X." }] },
          stopReason: "end_turn",
        };
      }
      mainCalls++;
      if (req.messages.length > 6) throw overflow(); // ~6 fit; 12 → compact to 6 → fits
      return okMsg;
    },
  };
  const r = await makeKernel(provider).runWithMessages(history(12));
  expect("completes after compaction", r.finalText === "ok");
  expect("result reports compacted=true", r.compacted === true);
  expect("summariser invoked exactly once", summarizeCalls === 1, `calls=${summarizeCalls}`);
  expect("compaction resolved the overflow without dropping", mainCalls === 2, `mainCalls=${mainCalls}`);
  expect(
    "surfaces a compaction notice",
    Array.isArray(r.notices) && r.notices.some((n) => /summari|compact/i.test(n)),
    JSON.stringify(r.notices),
  );
}

// 2. No overflow → no summary call, no notices.
{
  const provider = {
    id: "fake",
    capabilities: {},
    async complete(req) {
      if (isSummaryReq(req)) throw new Error("should not summarise");
      return okMsg;
    },
  };
  const r = await makeKernel(provider).runWithMessages([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  expect("no notices when nothing overflows", !r.notices || r.notices.length === 0);
  expect("compacted is unset when nothing overflows", !r.compacted);
}

// 3. Summariser failure → falls back to dropping oldest; still completes; no false notice.
{
  let mainCalls = 0;
  const provider = {
    id: "fake",
    capabilities: {},
    async complete(req) {
      if (isSummaryReq(req)) throw new Error("summary upstream 500");
      mainCalls++;
      if (req.messages.length > 3) throw overflow();
      return okMsg;
    },
  };
  const r = await makeKernel(provider).runWithMessages(history(10));
  expect("falls back to drop when summariser fails", r.finalText === "ok", `mainCalls=${mainCalls}`);
  expect(
    "no compaction notice when summary failed",
    !r.notices || !r.notices.some((n) => /summari|compact/i.test(n)),
    JSON.stringify(r.notices ?? []),
  );
  expect("drop fallback still reports compacted=true", r.compacted === true);
}

// 4. Persistent-compaction replay: applyCompactionCut starts the tail at the latest marker
// and folds the marker (user-role) into an adjacent user message to keep alternation valid.
{
  const { applyCompactionCut } = await import("../dist/kernel/agent-turn.js");
  const { COMPACTION_CHANNEL } = await import("../dist/sessions/store.js");
  const pm = (role, text, channel = null) => ({
    id: text, sessionId: "s", role, channel, externalMessageId: null,
    content: [{ type: "text", text }], createdAt: "2026-01-01T00:00:00.000Z",
  });
  const tail = [
    pm("user", "old question"),
    pm("assistant", "old answer"),
    pm("user", "SUMMARY", COMPACTION_CHANNEL),
    pm("user", "new question"),
    pm("assistant", "new answer"),
  ];
  const cut = applyCompactionCut(tail);
  expect("cut drops everything before the marker", cut.length === 2, `len=${cut.length}`);
  expect(
    "marker folds into the next user message (summary first)",
    cut[0].role === "user" &&
      cut[0].content.map((c) => c.text).join("|") === "SUMMARY|new question",
    JSON.stringify(cut[0].content),
  );
  expect("messages after the marker are intact", cut[1].content[0].text === "new answer");
  expect("no marker → tail unchanged", applyCompactionCut(tail.slice(3)).length === 2);
  // Two markers (a second compaction) → cut at the LATEST.
  const twice = [...tail, pm("user", "SUMMARY2", COMPACTION_CHANNEL), pm("user", "latest")];
  const cut2 = applyCompactionCut(twice);
  expect(
    "multiple markers cut at the latest",
    cut2.length === 1 && cut2[0].content.map((c) => c.text).join("|") === "SUMMARY2|latest",
    JSON.stringify(cut2.map((m) => m.content)),
  );
}

// 5. /compact trigger detection: bare command (with optional focus hint) on a user message;
// resume markers, mid-text mentions, and assistant rows don't match.
{
  const { detectCompactCommand } = await import("../dist/kernel/agent-turn.js");
  const pm = (role, parts) => ({
    id: "x", sessionId: "s", role, channel: null, externalMessageId: null,
    content: parts.map((text) => ({ type: "text", text })), createdAt: "2026-01-01T00:00:00.000Z",
  });
  const hit = detectCompactCommand(pm("user", ["/compact"]));
  expect("detects bare /compact", hit !== null && hit.focus === "", JSON.stringify(hit));
  const focused = detectCompactCommand(pm("user", ["/compact the deploy plan"]));
  expect("captures the focus hint", focused !== null && focused.focus === "the deploy plan", JSON.stringify(focused));
  const resumed = detectCompactCommand(pm("user", ["[session resumed after 2 hours of inactivity]", "/compact"]));
  expect("matches alongside a session-resume marker part", resumed !== null);
  expect("ignores mid-text mentions", detectCompactCommand(pm("user", ["please run /compact"])) === null);
  expect("ignores other commands", detectCompactCommand(pm("user", ["/ship now"])) === null);
  expect("ignores assistant rows", detectCompactCommand(pm("assistant", ["/compact"])) === null);
}

// 6. /compact execution against a REAL temp SessionStore: persists the reply + a marker
// whose summary came from the provider; later turns' cut starts at that marker. Focus hints
// reach the summariser; summarise failure persists the apologetic reply and NO marker;
// a near-empty session declines politely.
{
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const { SessionStore, COMPACTION_CHANNEL } = await import("../dist/sessions/store.js");
  const { runCompactCommand, applyCompactionCut } = await import("../dist/kernel/agent-turn.js");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dae-compact-"));
  const sessions = new SessionStore(path.join(tmp, "s.db"));
  const userId = sessions.resolveUser("web", "u1");
  const session = sessions.getOrCreateSession(userId, "orchestrator");
  const say = (role, text) =>
    sessions.appendMessage({ sessionId: session.id, role, content: [{ type: "text", text }] });
  say("user", "plan the deploy");
  say("assistant", "here is the plan");
  say("user", "/compact focus on the deploy plan");

  let summaryPrompt = "";
  const provider = {
    id: "fake",
    capabilities: {},
    async complete(req) {
      summaryPrompt = req.messages[0].content[0].text;
      return { message: { role: "assistant", content: [{ type: "text", text: "THE-SUMMARY" }] }, stopReason: "end_turn" };
    },
  };
  const reply = await runCompactCommand({
    provider, model: "test", sessions, sessionId: session.id, historyLimit: 40, focus: "the deploy plan",
  });
  expect("/compact replies with a confirmation", /Compacted/.test(reply), reply);
  expect("focus hint reaches the summariser", /Pay particular attention to: the deploy plan/.test(summaryPrompt));
  const tail = sessions.tail(session.id, 40);
  const marker = tail[tail.length - 1];
  expect("marker is the last persisted message", marker.channel === COMPACTION_CHANNEL, JSON.stringify(marker));
  expect("marker carries the summary", /THE-SUMMARY/.test(marker.content[0].text));
  expect("the reply itself was persisted", tail[tail.length - 2].role === "assistant" && /Compacted/.test(tail[tail.length - 2].content[0].text));
  say("user", "next question");
  const view = applyCompactionCut(sessions.tail(session.id, 40));
  expect(
    "next turn's view starts at the marker (summary folded into the new message)",
    view.length === 1 && /THE-SUMMARY/.test(view[0].content[0].text) && /next question/.test(view[0].content[1].text),
    JSON.stringify(view.map((m) => m.content.map((c) => c.text))),
  );

  // Summarise failure → apologetic reply persisted, no marker.
  const s2 = sessions.createSession(userId, "orchestrator", "fail-case");
  const say2 = (role, text) => sessions.appendMessage({ sessionId: s2.id, role, content: [{ type: "text", text }] });
  say2("user", "hello"); say2("assistant", "hi"); say2("user", "/compact");
  const failing = { id: "fake", capabilities: {}, async complete() { throw new Error("400 bad request"); } };
  const failReply = await runCompactCommand({ provider: failing, model: "test", sessions, sessionId: s2.id, historyLimit: 40, focus: "" });
  expect("summarise failure → apologetic reply", /couldn't compact/.test(failReply), failReply);
  expect("summarise failure → no marker persisted", !sessions.tail(s2.id, 40).some((m) => m.channel === COMPACTION_CHANNEL));

  // Near-empty session → polite decline, no marker.
  const s3 = sessions.createSession(userId, "orchestrator", "empty-case");
  sessions.appendMessage({ sessionId: s3.id, role: "user", content: [{ type: "text", text: "/compact" }] });
  const emptyReply = await runCompactCommand({ provider, model: "test", sessions, sessionId: s3.id, historyLimit: 40, focus: "" });
  expect("nothing to compact → polite decline", /not much conversation/.test(emptyReply), emptyReply);
  expect("nothing to compact → no marker persisted", !sessions.tail(s3.id, 40).some((m) => m.channel === COMPACTION_CHANNEL));

  sessions.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
