// Smoke for the web channel's UI + API: serves the chat shell unauthenticated at GET /,
// replays session history at GET /history, accepts messages at POST /messages, and a
// bearer token (when set) gates the API routes but NOT the UI shell.

import { WebChannel } from "../dist/channels/web.js";

let pass = true;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) pass = false;
};

// Minimal SessionStore stub returning canned history.
const fakeSessions = {
  resolveUser: () => "user-1",
  getOrCreateSession: () => ({ id: "sess-1", userId: "user-1", agentName: "orchestrator" }),
  tail: () => [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    { role: "tool", content: [{ type: "text", text: "should be filtered out" }] },
  ],
};

const published = [];
const ctx = { publish: async (m) => { published.push(m); } };

async function run(port, token) {
  const ch = new WebChannel({ defaultAgent: "orchestrator", port, token, sessions: fakeSessions });
  await ch.start(ctx);
  const base = `http://127.0.0.1:${port}`;
  return { ch, base };
}

// 1. No-token channel.
{
  const { ch, base } = await run(8791);
  const home = await fetch(base + "/");
  const html = await home.text();
  ok("GET / serves HTML shell", home.status === 200 && /<!doctype html>/i.test(html) && html.includes("/events"));
  ok("shell includes an inline SVG favicon", /<link rel="icon"[^>]*data:image\/svg\+xml/.test(html));

  const hist = await fetch(base + "/history?externalUserId=u1");
  const hj = await hist.json();
  ok(
    "GET /history replays user+assistant text (tool filtered)",
    hist.status === 200 && hj.messages.length === 2 && hj.messages[0].text === "hello" && hj.messages[1].role === "assistant",
    JSON.stringify(hj.messages),
  );

  const hist400 = await fetch(base + "/history");
  ok("GET /history without externalUserId → 400", hist400.status === 400);

  const post = await fetch(base + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ externalUserId: "u1", text: "ping" }),
  });
  ok("POST /messages → 202 + published", post.status === 202 && published.some((m) => m.text === "ping" && m.channel === "web"));
  await ch.stop();
}

// 2. Token-gated channel: shell open, API gated.
{
  const { ch, base } = await run(8792, "secret");
  const home = await fetch(base + "/");
  ok("token set → GET / still open (200)", home.status === 200);

  const noTok = await fetch(base + "/history?externalUserId=u1");
  ok("token set → /history without token → 401", noTok.status === 401);

  const qTok = await fetch(base + "/history?externalUserId=u1&token=secret");
  ok("token set → /history?token=… → 200 (SSE-style auth)", qTok.status === 200);

  const hdrTok = await fetch(base + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer secret" },
    body: JSON.stringify({ externalUserId: "u1", text: "auth" }),
  });
  ok("token set → POST /messages with Bearer → 202", hdrTok.status === 202);

  const badTok = await fetch(base + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer wrong" },
    body: JSON.stringify({ externalUserId: "u1", text: "nope" }),
  });
  ok("token set → wrong Bearer → 401", badTok.status === 401);
  await ch.stop();
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
