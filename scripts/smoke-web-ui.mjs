// Smoke for the web channel's UI + API: serves the chat shell unauthenticated at GET /,
// replays session history at GET /history, accepts messages at POST /messages, and a
// bearer token (when set) gates the API routes but NOT the UI shell.

import http from "node:http";
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

// 3. Login mode: own /login page, signed-cookie auth, user derived from the cookie.
{
  const { hashPassword } = await import("../dist/channels/web-auth.js");
  const auth = { username: "admin", passwordHash: hashPassword("pw"), sessionSecret: "sess-secret" };
  const ch = new WebChannel({ defaultAgent: "orchestrator", port: 8793, auth, sessions: fakeSessions });
  await ch.start(ctx);
  const base = "http://127.0.0.1:8793";

  const home = await fetch(base + "/", { redirect: "manual" });
  ok("login: GET / unauthenticated → 302 /login", home.status === 302 && home.headers.get("location") === "/login");

  const loginPage = await fetch(base + "/login");
  const lp = await loginPage.text();
  ok("login: GET /login serves the sign-in page", loginPage.status === 200 && /Sign in/i.test(lp));

  ok("login: API without cookie → 401", (await fetch(base + "/history")).status === 401);

  const bad = await fetch(base + "/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "wrong" }),
  });
  ok("login: wrong password → 401", bad.status === 401);

  const good = await fetch(base + "/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: "admin", password: "pw" }),
  });
  const setCookie = good.headers.get("set-cookie") || "";
  ok(
    "login: correct creds → 200 + HttpOnly session cookie",
    good.status === 200 && /dae_session=/.test(setCookie) && /HttpOnly/i.test(setCookie),
  );
  const cookie = setCookie.split(";")[0];

  const app = await fetch(base + "/", { headers: { cookie } });
  const appHtml = await app.text();
  ok(
    "login: GET / with cookie → 200 app shell with mode=login",
    app.status === 200 && /<!doctype html>/i.test(appHtml) && /var MODE = "login"/.test(appHtml),
  );

  ok("login: /history with cookie, no externalUserId → 200", (await fetch(base + "/history", { headers: { cookie } })).status === 200);

  const post = await fetch(base + "/messages", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ text: "hi-login" }),
  });
  ok(
    "login: POST /messages with cookie → 202, user forced to the logged-in name",
    post.status === 202 && published.some((m) => m.text === "hi-login" && m.externalUserId === "admin"),
  );

  const out = await fetch(base + "/logout", { method: "POST", headers: { cookie } });
  ok("login: POST /logout → 204 + clears cookie", out.status === 204 && /Max-Age=0/.test(out.headers.get("set-cookie") || ""));

  await ch.stop();
}

// 4. SSE broadcast: a user can have multiple live connections (tabs/reconnects); a reply must
//    reach ALL of them, not just the last to connect (the login-mode delivery bug).
{
  const ch = new WebChannel({ defaultAgent: "orchestrator", port: 8794, sessions: fakeSessions });
  await ch.start(ctx);
  const base = "http://127.0.0.1:8794";
  const openSse = (user) =>
    new Promise((resolve) => {
      const req = http.get(base + "/events?externalUserId=" + user, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c.toString()));
        resolve({ req, get: () => buf });
      });
    });
  const a = await openSse("u1");
  const b = await openSse("u1");
  await new Promise((r) => setTimeout(r, 120)); // let both register

  await ch.send("u1", { text: "broadcast-test" });
  await new Promise((r) => setTimeout(r, 120)); // let it flush to both sockets

  ok("SSE broadcast: connection A received the reply", /broadcast-test/.test(a.get()));
  ok("SSE broadcast: connection B (same user) ALSO received it", /broadcast-test/.test(b.get()));
  a.req.destroy();
  b.req.destroy();
  await ch.stop();
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
