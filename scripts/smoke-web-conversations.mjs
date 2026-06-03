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

  // Delete protections + behaviour.
  const delMain = await fetch(base + "/conversations?externalUserId=" + U1 + "&id=" + mainId, { method: "DELETE" });
  ok("DELETE Main → 403 (protected)", delMain.status === 403);
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

  await ch.stop();
  sessions.close();
}

// ---------------------------------------------------------------------------------------
// Part 2 — migration: a legacy DB with UNIQUE(user_id, agent_name) and no `title` column is
// upgraded in place (rows preserved, constraint dropped so multiple sessions can coexist).
// ---------------------------------------------------------------------------------------
{
  const dbPath = path.join(tmp, "legacy.db");
  // Hand-build the pre-conversations schema and seed a user + session + message.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
    CREATE TABLE user_identities (user_id TEXT NOT NULL, channel TEXT NOT NULL, external_id TEXT NOT NULL, PRIMARY KEY (channel, external_id));
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, agent_name TEXT NOT NULL,
      created_at TEXT NOT NULL, last_active_at TEXT NOT NULL, UNIQUE (user_id, agent_name)
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL, channel TEXT,
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
