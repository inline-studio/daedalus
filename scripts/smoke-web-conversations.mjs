// Smoke for the web channel's separate-conversations feature (Claude.ai-style sessions).
// Drives a REAL SessionStore (temp DB) behind a real WebChannel and asserts:
//   - the conversation routes (GET/POST/DELETE /conversations) behave + protect "Main"
//   - history + messages are scoped to a conversation (context isolation)
//   - a client can't read or target another user's conversation (ownership)
//   - SSE replies route only to the matching conversation's stream
//   - the SessionStore migrates a legacy UNIQUE(user_id, agent_name) DB and drops the constraint

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { WebChannel } from "../dist/channels/web.js";
import { SessionStore } from "../dist/sessions/store.js";
import { cleanTitle } from "../dist/sessions/title.js";

let pass = true;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) pass = false;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dae-convo-"));
const AGENT = "orchestrator";

// ---------------------------------------------------------------------------------------
// Part 1 — conversation routes, isolation, ownership, SSE routing (real store + channel).
// ---------------------------------------------------------------------------------------
{
  const dbPath = path.join(tmp, "sessions.db");
  const sessions = new SessionStore(dbPath);
  const published = [];
  const ctx = { publish: async (m) => { published.push(m); } };
  const ch = new WebChannel({ defaultAgent: AGENT, port: 8801, sessions });
  await ch.start(ctx);
  const base = "http://127.0.0.1:8801";
  const U1 = "web-user-one";
  const U2 = "web-user-two";

  const getJson = async (url) => (await fetch(base + url)).json();
  const post = (url, body) =>
    fetch(base + url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  // GET /conversations bootstraps a Main session.
  const c0 = await getJson("/conversations?externalUserId=" + U1);
  ok("GET /conversations returns a defaultId + a Main entry", Boolean(c0.defaultId) && c0.conversations.length === 1 && c0.conversations[0].id === c0.defaultId, JSON.stringify(c0));
  const mainId = c0.defaultId;

  // Create a second conversation.
  const created = await (await post("/conversations?externalUserId=" + U1, {})).json();
  ok("POST /conversations creates a new conversation with its own id", Boolean(created.id) && created.id !== mainId, JSON.stringify(created));
  const convB = created.id;

  const c1 = await getJson("/conversations?externalUserId=" + U1);
  ok("GET /conversations now lists both conversations", c1.conversations.length === 2);

  // Send a message to each conversation; capture the conversationId the channel forwards.
  const pMain = await post("/messages", { externalUserId: U1, text: "hello main" });
  ok("POST /messages (no conversationId) → 202", pMain.status === 202);
  const pB = await post("/messages", { externalUserId: U1, text: "hello B", conversationId: convB });
  ok("POST /messages with conversationId → 202", pB.status === 202);
  ok("publish for Main carries no conversationId (defaults)", published.some((m) => m.text === "hello main" && !m.conversationId));
  ok("publish for B carries conversationId=B", published.some((m) => m.text === "hello B" && m.conversationId === convB));

  // Simulate the supervisor/agent writing turns into the resolved sessions, then assert
  // /history is scoped per conversation (the core context-isolation guarantee).
  const userId1 = sessions.resolveUser("web", U1);
  sessions.appendMessage({ sessionId: mainId, role: "user", content: [{ type: "text", text: "hello main" }] });
  sessions.appendMessage({ sessionId: mainId, role: "assistant", content: [{ type: "text", text: "reply in main" }] });
  sessions.appendMessage({ sessionId: convB, role: "user", content: [{ type: "text", text: "hello B" }] });
  sessions.appendMessage({ sessionId: convB, role: "assistant", content: [{ type: "text", text: "reply in B" }] });

  const histMain = await getJson("/history?externalUserId=" + U1 + "&conversationId=" + mainId);
  const histB = await getJson("/history?externalUserId=" + U1 + "&conversationId=" + convB);
  const mainTexts = histMain.messages.map((m) => m.text);
  const bTexts = histB.messages.map((m) => m.text);
  ok("ISOLATION: Main history has only Main's messages", mainTexts.includes("reply in main") && !mainTexts.includes("reply in B"), JSON.stringify(mainTexts));
  ok("ISOLATION: B history has only B's messages", bTexts.includes("reply in B") && !bTexts.includes("reply in main"), JSON.stringify(bTexts));

  // Ownership: U2 must not be able to read U1's conversation B — it falls back to U2's own Main.
  const histCross = await getJson("/history?externalUserId=" + U2 + "&conversationId=" + convB);
  ok("OWNERSHIP: reading another user's conversation does not leak its messages", !histCross.messages.some((m) => m.text === "reply in B"), JSON.stringify(histCross.messages));

  // History blocks: assistant turns reconstruct thinking + tool rows (with resolved ✓/✗) on
  // reload, not just flattened text — so the activity chrome survives a reload / device switch.
  sessions.appendMessage({ sessionId: convB, role: "assistant", content: [
    { type: "thinking", thinking: "let me check", signature: "s" },
    { type: "text", text: "Here is the answer." },
    { type: "tool_use", id: "tA", name: "web_fetch", input: { url: "https://example.com" } },
  ] });
  sessions.appendMessage({ sessionId: convB, role: "user", content: [
    { type: "tool_result", toolUseId: "tA", content: "ok" },
  ] });
  const histBlocks = await getJson("/history?externalUserId=" + U1 + "&conversationId=" + convB);
  const lastAsst = histBlocks.messages.filter((m) => m.role === "assistant").pop();
  const blocks = (lastAsst && lastAsst.blocks) || [];
  ok("HISTORY BLOCKS: assistant turn carries 3 structured blocks", blocks.length === 3, JSON.stringify(blocks.map((b) => b.t)));
  ok("HISTORY BLOCKS: thinking → text → tool, in order", blocks[0] && blocks[0].t === "thinking" && blocks[1] && blocks[1].t === "text" && blocks[2] && blocks[2].t === "tool");
  ok("HISTORY BLOCKS: tool carries name/input/resolved ok state", blocks[2] && blocks[2].name === "web_fetch" && blocks[2].input && blocks[2].input.url === "https://example.com" && blocks[2].isError === false);

  // Ownership: U2 targeting U1's conversation in /messages → the forged id is dropped.
  await post("/messages", { externalUserId: U2, text: "intruder", conversationId: convB });
  ok("OWNERSHIP: a message targeting another user's conversation drops the id", published.some((m) => m.text === "intruder" && !m.conversationId));

  // SSE routing: a reply tagged with conversationId reaches only that conversation's stream.
  const openSse = (user, conversationId) =>
    new Promise((resolve) => {
      const req = http.get(base + "/events?externalUserId=" + user + "&conversationId=" + conversationId, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c.toString()));
        resolve({ req, get: () => buf });
      });
    });
  const sMain = await openSse(U1, mainId);
  const sB = await openSse(U1, convB);
  await sleep(120);
  await ch.send(U1, { text: "routed-to-B", conversationId: convB });
  await sleep(120);
  ok("SSE ROUTING: conversation B's stream received the reply", /routed-to-B/.test(sB.get()));
  ok("SSE ROUTING: Main's stream did NOT receive B's reply", !/routed-to-B/.test(sMain.get()));
  sMain.req.destroy();
  sB.req.destroy();

  // Delete behaviour. Main's ROW survives a delete (it's the cross-channel default and must
  // stay the oldest session) — its history is cleared instead.
  const delMain = await fetch(base + "/conversations?externalUserId=" + U1 + "&id=" + mainId, { method: "DELETE" });
  const delMainBody = await delMain.json();
  ok("DELETE Main → 200 with cleared:true", delMain.status === 200 && delMainBody.cleared === true, JSON.stringify(delMainBody));
  const cMain = await getJson("/conversations?externalUserId=" + U1);
  ok("DELETE Main keeps the entry and its id", cMain.defaultId === mainId && cMain.conversations.some((c) => c.id === mainId));
  const histMainCleared = await getJson("/history?externalUserId=" + U1 + "&conversationId=" + mainId);
  ok("DELETE Main cleared its history", histMainCleared.messages.length === 0, JSON.stringify(histMainCleared.messages));
  const delForeign = await fetch(base + "/conversations?externalUserId=" + U2 + "&id=" + convB, { method: "DELETE" });
  ok("DELETE another user's conversation → 404", delForeign.status === 404);
  const delB = await fetch(base + "/conversations?externalUserId=" + U1 + "&id=" + convB, { method: "DELETE" });
  ok("DELETE own conversation → 200", delB.status === 200);
  const c2 = await getJson("/conversations?externalUserId=" + U1);
  ok("after delete, only Main remains", c2.conversations.length === 1 && c2.conversations[0].id === mainId);
  const histGone = await getJson("/history?externalUserId=" + U1 + "&conversationId=" + convB);
  ok("deleted conversation's messages are gone (falls back to empty Main view)", !histGone.messages.some((m) => m.text === "reply in B"));

  // "New chat" guardrail — use a fresh user so the counts above are undisturbed.
  const U3 = "web-user-three";
  await getJson("/conversations?externalUserId=" + U3); // bootstrap Main
  const e1 = await (await post("/conversations?externalUserId=" + U3, {})).json();
  const e2 = await (await post("/conversations?externalUserId=" + U3, {})).json();
  ok("GUARDRAIL: repeated New chat reuses the one empty conversation", e1.id === e2.id, e1.id + " vs " + e2.id);
  const listU3 = await getJson("/conversations?externalUserId=" + U3);
  ok("GUARDRAIL: no pile-up — exactly Main + one empty conversation", listU3.conversations.length === 2);
  // Once the empty conversation has been used, a new create makes a distinct one.
  sessions.appendMessage({ sessionId: e1.id, role: "user", content: [{ type: "text", text: "first" }] });
  const e3 = await (await post("/conversations?externalUserId=" + U3, {})).json();
  ok("GUARDRAIL: after the empty conv is used, New chat creates a fresh one", e3.id !== e1.id);

  // GET /commands: built-ins (/compact) always present; brain commands appended when a
  // loader is injected.
  const cmds0 = await getJson("/commands");
  ok(
    "GET /commands without a loader → built-ins only",
    Array.isArray(cmds0.commands) && cmds0.commands.length === 1 && cmds0.commands[0].name === "compact",
    JSON.stringify(cmds0),
  );
  const ch2 = new WebChannel({
    defaultAgent: AGENT,
    port: 8802,
    listCommands: async () => [{ name: "ship", description: "Ship it", aliases: ["s"] }],
  });
  await ch2.start(ctx);
  const cmds = await (await fetch("http://127.0.0.1:8802/commands")).json();
  ok(
    "GET /commands serves built-ins + the injected command list",
    cmds.commands.length === 2 && cmds.commands[0].name === "compact" && cmds.commands[1].name === "ship",
    JSON.stringify(cmds),
  );
  await ch2.stop();

  await ch.stop();
  sessions.close();
}

// ---------------------------------------------------------------------------------------
// Part 2 — migration: a legacy DB with UNIQUE(user_id, agent_name) and no `title` column is
// upgraded in place (rows preserved, constraint dropped so multiple sessions can coexist).
// ---------------------------------------------------------------------------------------
{
  const dbPath = path.join(tmp, "legacy.db");
  // Hand-build the REAL pre-conversations schema — including the foreign keys the production DB
  // actually has (`REFERENCES users(id)`, `REFERENCES sessions(id)`). The first cut of this test
  // omitted them, which is exactly why it missed that the migration broke writes on real DBs.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE user_identities (user_id TEXT NOT NULL REFERENCES users(id), channel TEXT NOT NULL, external_id TEXT NOT NULL, PRIMARY KEY (channel, external_id));
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), agent_name TEXT NOT NULL,
      created_at TEXT NOT NULL, last_active_at TEXT NOT NULL, UNIQUE (user_id, agent_name)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), role TEXT NOT NULL, channel TEXT,
      external_message_id TEXT, content_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    INSERT INTO users VALUES ('u-legacy', '2020-01-01T00:00:00.000Z');
    INSERT INTO user_identities VALUES ('u-legacy', 'web', 'legacy-ext');
    INSERT INTO sessions VALUES ('s-legacy', 'u-legacy', 'orchestrator', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('m-legacy', 's-legacy', 'assistant', 'web', NULL, '[{"type":"text","text":"old reply"}]', '2020-01-01T00:00:00.000Z');
  `);
  raw.close();

  // Opening via SessionStore should migrate it.
  const store = new SessionStore(dbPath);
  const def = store.getOrCreateSession("u-legacy", "orchestrator");
  ok("MIGRATION: legacy session id is preserved as the default", def.id === "s-legacy");
  ok("MIGRATION: legacy session now exposes a (null) title field", def.title === null);
  const tail = store.tail("s-legacy", 10);
  ok("MIGRATION: legacy message survived the rebuild", tail.length === 1 && tail[0].content[0].text === "old reply");

  // THE REGRESSION GUARD: a write must succeed after migrating a DB that had the messages FK.
  // (The broken migration left messages referencing a dropped table, so every append threw
  // "FOREIGN KEY constraint failed" — which surfaced as "Something went wrong" on every turn.)
  let appendOk = false;
  try {
    store.appendMessage({ sessionId: "s-legacy", role: "user", content: [{ type: "text", text: "after migrate" }] });
    appendOk = true;
  } catch (e) {
    console.log("   appendMessage error:", e.message);
  }
  ok("MIGRATION: appendMessage works after migrating a DB with the messages FK", appendOk);

  // The UNIQUE constraint must be gone — a second session for the same (user, agent) succeeds.
  let secondOk = false;
  try {
    const second = store.createSession("u-legacy", "orchestrator", "second");
    secondOk = Boolean(second.id) && second.id !== "s-legacy";
  } catch (e) {
    secondOk = false;
  }
  ok("MIGRATION: UNIQUE(user_id, agent_name) dropped — a second session can be created", secondOk);
  ok("MIGRATION: listSessions returns both sessions", store.listSessions("u-legacy", "orchestrator").length === 2);

  // Idempotent: reopening doesn't re-migrate or lose data.
  store.close();
  const store2 = new SessionStore(dbPath);
  ok("MIGRATION: idempotent reopen keeps both sessions", store2.listSessions("u-legacy", "orchestrator").length === 2);
  store2.close();
}

// ---------------------------------------------------------------------------------------
// Part 2b — SELF-HEAL: a DB left half-migrated/damaged by the first (buggy) migration is
// repaired on open. That damaged shape: `sessions` already rebuilt (has `title`), a leftover
// `sessions_legacy` table, and `messages` whose FK was rewritten to `sessions_legacy`.
// ---------------------------------------------------------------------------------------
{
  const dbPath = path.join(tmp, "damaged.db");
  const raw = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
  raw.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE user_identities (user_id TEXT NOT NULL, channel TEXT NOT NULL, external_id TEXT NOT NULL, PRIMARY KEY (channel, external_id));
    CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_name TEXT NOT NULL, title TEXT, created_at TEXT NOT NULL, last_active_at TEXT NOT NULL);
    CREATE TABLE sessions_legacy (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_name TEXT NOT NULL, created_at TEXT NOT NULL, last_active_at TEXT NOT NULL, UNIQUE (user_id, agent_name));
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions_legacy(id), role TEXT NOT NULL, channel TEXT, external_message_id TEXT, content_json TEXT NOT NULL, created_at TEXT NOT NULL);
    INSERT INTO users VALUES ('u-d', '2020-01-01T00:00:00.000Z');
    INSERT INTO sessions VALUES ('s-d', 'u-d', 'orchestrator', NULL, '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    INSERT INTO sessions_legacy VALUES ('s-d', 'u-d', 'orchestrator', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z');
    INSERT INTO messages VALUES ('m-d', 's-d', 'assistant', 'web', NULL, '[{"type":"text","text":"survivor"}]', '2020-01-01T00:00:00.000Z');
  `);
  raw.close();

  const store = new SessionStore(dbPath); // opening should self-heal
  let appendOk = false;
  try {
    store.appendMessage({ sessionId: "s-d", role: "user", content: [{ type: "text", text: "heals" }] });
    appendOk = true;
  } catch (e) {
    console.log("   appendMessage error:", e.message);
  }
  ok("SELF-HEAL: appendMessage works after opening a damaged DB", appendOk);
  ok("SELF-HEAL: original message preserved", store.tail("s-d", 10).some((m) => m.content[0].text === "survivor"));
  store.close();

  const insp = new DatabaseSync(dbPath, { enableForeignKeyConstraints: false });
  const tables = insp.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  const msgSql = (insp.prepare("SELECT sql FROM sqlite_master WHERE name='messages'").get() || {}).sql || "";
  ok("SELF-HEAL: leftover sessions_legacy table removed", !tables.includes("sessions_legacy"), tables.join(","));
  ok("SELF-HEAL: messages FK repaired to reference sessions", /references\s+sessions\b/i.test(msgSql) && !/sessions_legacy/.test(msgSql));
  insp.close();
}

// ---------------------------------------------------------------------------------------
// Part 3 — cleanTitle: the model's raw title response is sanitised before it becomes a label.
// ---------------------------------------------------------------------------------------
ok("cleanTitle: strips wrapping quotes and trailing period", cleanTitle('"Refactor the auth module."') === "Refactor the auth module", cleanTitle('"Refactor the auth module."'));
ok("cleanTitle: collapses inner whitespace", cleanTitle("Plan   the   roadmap") === "Plan the roadmap");
ok("cleanTitle: takes the first line only", cleanTitle("Weather setup\nignore this") === "Weather setup");
ok("cleanTitle: strips a code fence", cleanTitle("```\nDeploy pipeline\n```") === "Deploy pipeline");
ok("cleanTitle: blank input yields empty string", cleanTitle("   ") === "");
ok("cleanTitle: caps very long titles", cleanTitle("x".repeat(80)).length <= 60);

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
