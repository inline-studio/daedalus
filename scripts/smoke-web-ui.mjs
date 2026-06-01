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
  // Cache-busting headers — without these the browser caches the inline
  // JS/CSS shell aggressively, so a `dae update` never reaches the user
  // until they hard-refresh. Scott hit exactly this after PR #82 deployed.
  {
    const cc = home.headers.get("cache-control") ?? "";
    ok(
      "shell sends Cache-Control: no-store (so a `dae update` lands without hard-refresh)",
      /no-store/.test(cc) && /no-cache/.test(cc),
      cc,
    );
    ok(
      "shell sends Pragma: no-cache (HTTP/1.0 belt-and-braces)",
      home.headers.get("pragma") === "no-cache",
    );
  }

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

// 5. SSE reconnect replay: when EventSource reconnects, the browser sends
//    `Last-Event-ID: <iso>`. The server must replay any assistant messages
//    persisted since that timestamp BEFORE going live, so a reply that
//    landed during the disconnect gap reaches the user without a refresh.
{
  const replaySessions = {
    resolveUser: () => "user-r",
    getOrCreateSession: () => ({ id: "sess-r", userId: "user-r", agentName: "orchestrator" }),
    tail: () => [],
    // The new method under test. Returns messages with createdAt > sinceIso
    // in chronological order.
    messagesSince: (sessionId, sinceIso) => {
      const all = [
        { id: "m1", role: "assistant", content: [{ type: "text", text: "missed-A" }], createdAt: "2026-05-26T10:00:01.000Z" },
        { id: "m2", role: "user", content: [{ type: "text", text: "user-typed-mid-gap" }], createdAt: "2026-05-26T10:00:02.000Z" },
        { id: "m3", role: "assistant", content: [{ type: "text", text: "missed-B" }], createdAt: "2026-05-26T10:00:03.000Z" },
        { id: "m4", role: "tool", content: [{ type: "text", text: "tool-noise" }], createdAt: "2026-05-26T10:00:04.000Z" },
      ];
      return all.filter((m) => m.createdAt > sinceIso);
    },
  };
  const ch = new (await import("../dist/channels/web.js")).WebChannel({
    defaultAgent: "orchestrator",
    port: 8795,
    sessions: replaySessions,
  });
  await ch.start(ctx);
  const base = "http://127.0.0.1:8795";

  const openSseWith = (user, lastEventId) =>
    new Promise((resolve) => {
      const headers = {};
      if (lastEventId) headers["Last-Event-ID"] = lastEventId;
      const req = http.get(base + "/events?externalUserId=" + user, { headers }, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c.toString()));
        resolve({ req, get: () => buf });
      });
    });

  // Open with a Last-Event-ID watermark BEFORE m1 — server should replay m1 + m3,
  // skip m2 (user) and m4 (tool). They arrive BEFORE any live send.
  const conn = await openSseWith("user-r", "2026-05-26T10:00:00.000Z");
  await new Promise((r) => setTimeout(r, 120));
  const replayed = conn.get();
  ok(
    "SSE replay: missed assistant text 'missed-A' resent on reconnect",
    /missed-A/.test(replayed),
  );
  ok(
    "SSE replay: missed assistant text 'missed-B' resent on reconnect",
    /missed-B/.test(replayed),
  );
  ok(
    "SSE replay: user-typed message NOT resent (client rendered it locally)",
    !/user-typed-mid-gap/.test(replayed),
  );
  ok(
    "SSE replay: tool/internal messages NOT leaked to the browser",
    !/tool-noise/.test(replayed),
  );
  ok(
    "SSE replay: each replayed event carries an `id:` line so the browser tracks watermark",
    /id: 2026-05-26T10:00:01.000Z\n.*missed-A/s.test(replayed) &&
      /id: 2026-05-26T10:00:03.000Z\n.*missed-B/s.test(replayed),
  );

  // Live send AFTER replay should still work and also carry an id.
  await ch.send("user-r", { text: "live-now" });
  await new Promise((r) => setTimeout(r, 120));
  const all = conn.get();
  ok(
    "SSE live: messages sent after the replay still carry id: + arrive",
    /live-now/.test(all) && /id: \d{4}-\d{2}-\d{2}T/.test(all.slice(all.indexOf("live-now") - 200, all.indexOf("live-now"))),
  );

  conn.req.destroy();
  await ch.stop();
}

// 6. Markdown table rendering. The renderTable + md functions live inside the
//    inline IIFE in WEB_UI_HTML — extract and eval them so we can test the
//    table parser end-to-end (the bug Scott hit: GFM tables landed as raw
//    `|`-noise paragraphs). Tests cover: header + separator + body roundtrip,
//    the strict reject (mixed prose with no blank line stays as plain <p>),
//    and the column-count mismatch heuristic.
{
  const { WEB_UI_HTML } = await import("../dist/channels/web-ui.js");
  // Pull the chunk from `function md(src) {` up to the next `function attachmentHtml(`
  // — that's md + renderTable, both we need.
  const start = WEB_UI_HTML.indexOf("function md(src)");
  const end = WEB_UI_HTML.indexOf("function attachmentHtml");
  if (start < 0 || end < 0 || end <= start) {
    ok("md/renderTable extraction from WEB_UI_HTML", false, "anchors moved — update the smoke");
  } else {
    // The extracted slice references `esc()` which lives earlier in the IIFE.
    // Shim it with the same behaviour (verbatim from web-ui.ts).
    const prelude =
      "function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }";
    const factory = new Function(
      `${prelude} ${WEB_UI_HTML.slice(start, end)} return { md: md, renderTable: renderTable };`,
    );
    const api = factory();

    // 6a. Scott's exact bug: a 3-col table renders as <table> with the right cells.
    {
      const src = "Here are the repos:\n\n| Name | Description | Language |\n|------|-------------|----------|\n| daedalus | agent runner | TypeScript |\n| nanoclaw | messaging agent | TypeScript |";
      const out = api.md(src);
      ok("table: emits a <table> tag", /<table>/.test(out));
      ok("table: emits <thead> + <tbody>", /<thead>/.test(out) && /<tbody>/.test(out));
      ok("table: header cell 'Name' wrapped in <th>", /<th>Name<\/th>/.test(out));
      ok("table: data cell 'daedalus' wrapped in <td>", /<td>daedalus<\/td>/.test(out));
      ok("table: data cell 'TypeScript' wrapped in <td>", /<td>TypeScript<\/td>/.test(out));
      ok("table: trailing data row 'nanoclaw' present", /<td>nanoclaw<\/td>/.test(out));
      ok("table: raw `|` noise no longer in output", !/\| Name \| Description/.test(out));
    }

    // 6b. Strict reject: prose mixed into the block (no blank line) → renders as <p>.
    {
      const src = "| a | b |\n|---|---|\n| 1 | 2 |\nfollow-up sentence";
      const out = api.md(src);
      ok("table: mixed prose without blank line → falls back to <p> (no silent drop)", !/<table>/.test(out) && /follow-up sentence/.test(out));
    }

    // 6c. Column-count mismatch: header has 3 pipes, separator has 4 → not a table.
    {
      const src = "| a | b |\n|---|---|---|\n| 1 | 2 |";
      const out = api.md(src);
      ok("table: header/separator pipe-count mismatch → not a table", !/<table>/.test(out));
    }

    // 6d. Negative: a single line with pipes isn't a table.
    {
      const out = api.md("just a | pipe | character");
      ok("table: a lone pipe-containing line stays a paragraph", !/<table>/.test(out));
    }
  }
}

// 7. Heartbeat is a NAMED event (not an SSE `: ping` comment) so the browser
//    surfaces it to JS. The client-side watchdog uses it to detect a silent
//    proxy-killed connection and force a reconnect — the bug Scott hit behind
//    Caddy on casa where messages stopped arriving live but the connection
//    badge stayed "connected". The event must NOT carry an `id:` line, or
//    Last-Event-ID would advance past unreceived messages and the replay
//    machinery would skip them.
//
//    We pass heartbeatMs: 50 so the smoke catches several heartbeats in
//    ~200ms without waiting on the real 20s production cadence.
{
  const ch = new (await import("../dist/channels/web.js")).WebChannel({
    defaultAgent: "orchestrator",
    port: 8796,
    sessions: fakeSessions,
    heartbeatMs: 50,
  });
  await ch.start(ctx);
  const base = "http://127.0.0.1:8796";

  const openRawSse = (user) =>
    new Promise((resolve) => {
      const req = http.get(base + "/events?externalUserId=" + user, (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c.toString()));
        resolve({ req, get: () => buf });
      });
    });
  const conn = await openRawSse("u-hb");
  await new Promise((r) => setTimeout(r, 200)); // wait for a few heartbeats
  const wire = conn.get();
  ok(
    "heartbeat fires on a recurring interval",
    (wire.match(/event: heartbeat/g) ?? []).length >= 2,
    `count: ${(wire.match(/event: heartbeat/g) ?? []).length}`,
  );
  ok(
    "heartbeat is a NAMED event (not an SSE `: ping` comment)",
    /event: heartbeat\ndata: \{\}/.test(wire) && !/^: ping/m.test(wire),
  );
  ok(
    "heartbeat has NO id line (Last-Event-ID is preserved across heartbeats)",
    !/id: [^\n]*\nevent: heartbeat/.test(wire),
  );

  // Sanity: a real message sent on the same connection DOES carry id (so
  // Last-Event-ID resume still works); the heartbeat just doesn't shift the
  // watermark backwards.
  await ch.send("u-hb", { text: "real-message" });
  await new Promise((r) => setTimeout(r, 100));
  const wire2 = conn.get();
  ok(
    "real messages still carry id: lines (heartbeat addition didn't break replay)",
    /id: [^\n]+\nevent: message\ndata: [^\n]*real-message/.test(wire2),
  );

  conn.req.destroy();
  await ch.stop();
}

// 9. Tool-heavy session: /history must not lose user text messages when many
//    tool round-trips occupy the raw-row window ahead of them. Each tool turn
//    writes two rows (assistant message with tool_use, plus a "user" message
//    holding the tool_results); only the assistant text is visible. With a
//    small raw tail the user's own questions fall out of the window even
//    though only a handful exist.
//
//    The fake session below mirrors that shape: one user text question, then
//    100 alternating assistant/tool_result rows. With RAW_TAIL=1000 all 201
//    rows are fetched and the user question survives the filter.
{
  const toolHeavySessions = {
    resolveUser: () => "user-th",
    getOrCreateSession: () => ({ id: "sess-th", userId: "user-th", agentName: "orchestrator" }),
    tail: (_id, limit) => {
      const rows = [];
      rows.push({ role: "user", content: [{ type: "text", text: "create me a droplet" }] });
      for (let i = 0; i < 100; i++) {
        rows.push({
          role: "assistant",
          content: [
            { type: "text", text: `step ${i + 1}` },
            { type: "tool_use", id: "t" + i, name: "bash", input: {} },
          ],
        });
        rows.push({
          role: "user",
          content: [{ type: "tool_result", toolUseId: "t" + i, content: "ok" }],
        });
      }
      // Caller passes the raw-tail limit; mirror tail()'s behaviour and
      // return the LAST `limit` rows in chronological order. If `limit` is
      // tiny (the old 50), the lone user text message is excluded.
      return rows.slice(-limit);
    },
  };
  const ch = new (await import("../dist/channels/web.js")).WebChannel({
    defaultAgent: "orchestrator",
    port: 8797,
    sessions: toolHeavySessions,
  });
  await ch.start(ctx);
  const base = "http://127.0.0.1:8797";
  const hist = await fetch(base + "/history?externalUserId=u-th");
  const hj = await hist.json();

  ok(
    "/history returns visible messages from a 200-row tool-heavy session",
    hist.status === 200 && hj.messages.length >= 100,
    `got ${hj.messages.length} messages`,
  );
  ok(
    "/history includes the user's own text question (was missing pre-fix)",
    hj.messages.some((m) => m.role === "user" && m.text === "create me a droplet"),
    JSON.stringify(hj.messages.slice(0, 3)),
  );
  ok(
    "/history includes assistant text from the tool-heavy turns",
    hj.messages.some((m) => m.role === "assistant" && /step 1\b/.test(m.text)) &&
      hj.messages.some((m) => m.role === "assistant" && /step 100/.test(m.text)),
  );
  ok(
    "/history filters out tool_result-only rows (no empty-text messages)",
    hj.messages.every((m) => typeof m.text === "string" && m.text.length > 0),
  );
  ok(
    "/history caps the visible response (so it doesn't grow unbounded)",
    hj.messages.length <= 200,
    `got ${hj.messages.length}`,
  );
  await ch.stop();
}

// 10. Layout + history-load invariants. A previous version stacked messages at
//     the top of #log with empty space below (flex-direction:column without a
//     justify-content rule), opposite of chat-app convention; AND the smart-
//     scroll pill incorrectly read "↓ N new messages" for messages that were
//     actually historical (bulk-loaded into the same code path as live SSE
//     deliveries). These are source-level invariants checked by string-
//     matching against WEB_UI_HTML — no browser harness involved.
{
  const { WEB_UI_HTML } = await import("../dist/channels/web-ui.js");

  // 10a. #log anchors content to the bottom via `margin-top: auto` on the
  //      first child. (A prior version used `justify-content: flex-end` on
  //      the parent, which works when content fits but has a Chromium bug
  //      where overflowing content can't be scrolled to — Brave reproduces
  //      it reliably. The margin-top:auto pattern collapses to 0 when
  //      content overflows, so native scroll behaves as expected.)
  ok(
    "#log anchors content via margin-top:auto on the first child",
    /#log\s*>\s*:first-child\s*\{\s*margin-top:\s*auto/.test(WEB_UI_HTML),
  );
  ok(
    "#log does NOT use justify-content: flex-end (overflow-scroll bug in Chromium)",
    !/#log\s*\{[^}]*justify-content:\s*flex-end/.test(WEB_UI_HTML),
  );

  // 10b. loadHistory bypasses the per-message smart-scroll work via a
  //      bulkLoading flag, then snaps to the bottom once. The pill must NOT
  //      get incremented for messages that are actually history.
  ok(
    "loadHistory uses bulkLoading flag to bypass smart-scroll",
    /bulkLoading\s*=\s*true[\s\S]*addMsg[\s\S]*bulkLoading\s*=\s*false/.test(WEB_UI_HTML),
  );
  ok(
    "loadHistory calls jumpToBottom() after the bulk-load",
    /bulkLoading\s*=\s*false[^]*jumpToBottom\(\)/.test(WEB_UI_HTML),
  );
  ok(
    "addMsg short-circuits to skip the scroll/pill work while bulkLoading",
    /if\s*\(\s*bulkLoading\s*\)\s*return\s+div/.test(WEB_UI_HTML),
  );

  // 10c. loadHistory's catch block surfaces errors to the console. The
  //      previous swallow made a missing-history report indistinguishable
  //      from a server-side empty response.
  ok(
    "loadHistory's catch block surfaces errors via console.error",
    WEB_UI_HTML.includes('console.error("loadHistory failed"'),
  );
}

// 11. The scroll listener must NOT force scroll position to the bottom. A
//     prior version called jumpToBottom() whenever isAtBottom() was true,
//     which meant a light upward scroll within the 60px isAtBottom threshold
//     was immediately snapped back. Only a hard scroll could move past it.
//     The listener should only update pill state.
{
  const { WEB_UI_HTML } = await import("../dist/channels/web-ui.js");
  // Capture just the listener body (`function () { … }`), not everything up to
  // addMsg — comments in adjoining blocks may legitimately mention
  // jumpToBottom and confuse the "no snap-back" check.
  const start = WEB_UI_HTML.indexOf('log.addEventListener("scroll"');
  const bodyStart = WEB_UI_HTML.indexOf("function () {", start);
  // End of the listener body: walk to the matching `});`.
  let bodyEnd = -1;
  if (bodyStart > 0) {
    let depth = 0;
    for (let i = bodyStart; i < WEB_UI_HTML.length; i++) {
      const c = WEB_UI_HTML[i];
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) { bodyEnd = i + 1; break; }
      }
    }
  }
  const block = bodyStart >= 0 && bodyEnd > bodyStart ? WEB_UI_HTML.slice(bodyStart, bodyEnd) : "";
  ok(
    "scroll listener exists",
    /log\.addEventListener\("scroll"/.test(WEB_UI_HTML.slice(start, start + 80)),
  );
  ok(
    "scroll listener body extracted (matched braces)",
    block.length > 0,
  );
  ok(
    "scroll listener body does NOT call jumpToBottom (no snap-back on light upward scroll)",
    block.length > 0 && !block.includes("jumpToBottom"),
  );
  ok(
    "scroll listener still dismisses the pill when the user returns to the bottom",
    /isAtBottom\(\)[\s\S]*newSinceScrolled\s*=\s*0[\s\S]*pill\.classList\.remove/.test(block),
  );
}

// 12. Copy button on code blocks. md() should emit a <button class="copy-btn">
//     inside every <pre>; #log should have a delegated click handler that
//     copies the contained <code> text to the clipboard.
{
  const { WEB_UI_HTML } = await import("../dist/channels/web-ui.js");

  // (a) The CSS for the button is present.
  ok(
    "CSS: .copy-btn is styled (positioned, has hover state)",
    /\.copy-btn\s*\{[^}]*position:\s*absolute/.test(WEB_UI_HTML),
  );
  ok(
    "CSS: .msg pre is position: relative (so the absolute button is anchored to it)",
    /\.msg pre\s*\{[^}]*position:\s*relative/.test(WEB_UI_HTML),
  );

  // (b) md() emits the Copy button inside every <pre> block. Re-extract the
  //     function the same way smoke #6 does and exercise it with a code
  //     fence input.
  const start = WEB_UI_HTML.indexOf("function md(src)");
  const end = WEB_UI_HTML.indexOf("function attachmentHtml");
  ok("md() extractable", start >= 0 && end > start);
  if (start >= 0 && end > start) {
    const prelude =
      "function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }";
    const api = new Function(
      `${prelude} ${WEB_UI_HTML.slice(start, end)} return { md: md };`,
    )();
    const out = api.md("```\nconsole.log(1)\n```");
    ok(
      "md() emits Copy button inside <pre>",
      /<pre>[\s\S]*class="copy-btn"[\s\S]*<code>/.test(out),
    );
    ok(
      "md() preserves the code body alongside the button",
      out.includes("console.log(1)"),
    );
    // Inline `code` must NOT get a button — it's only worth one for the
    // multi-line block form.
    const inlineOut = api.md("use `cd /tmp` to change");
    ok(
      "md() does NOT add a copy button to inline <code>",
      inlineOut.includes("<code>cd /tmp</code>") && !inlineOut.includes("copy-btn"),
    );
  }

  // (c) The delegated click handler exists on #log and walks up to a <pre>.
  ok(
    "click handler delegated on #log finds .copy-btn",
    /log\.addEventListener\("click"[\s\S]{0,400}closest\(["']\.copy-btn["']\)/.test(WEB_UI_HTML),
  );
  ok(
    "click handler reads the <code>.textContent",
    /pre\.querySelector\(["']code["']\)/.test(WEB_UI_HTML) && WEB_UI_HTML.includes(".textContent"),
  );
  ok(
    "click handler uses navigator.clipboard.writeText (modern path)",
    /navigator\.clipboard\.writeText/.test(WEB_UI_HTML),
  );
  ok(
    "click handler has an execCommand fallback for non-HTTPS contexts",
    /execCommand\(["']copy["']\)/.test(WEB_UI_HTML),
  );
}

// 13. User messages render through md() too. Previously the user branch
//     in addMsg HTML-escaped + wrapped in <p>, so typed markdown surfaced
//     as literal asterisks. Both roles should now share the rendering path
//     (the role still controls bubble styling — blue vs dark — via the
//     .msg.user/.msg.assistant classnames, not the content).
{
  const { WEB_UI_HTML } = await import("../dist/channels/web-ui.js");
  const fnStart = WEB_UI_HTML.indexOf("function addMsg(role, text, attachments)");
  ok("addMsg() exists", fnStart >= 0);
  if (fnStart >= 0) {
    // Slice to just the function body, brace-matched.
    const open = WEB_UI_HTML.indexOf("{", fnStart);
    let depth = 0, close = -1;
    for (let i = open; i < WEB_UI_HTML.length; i++) {
      const c = WEB_UI_HTML[i];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) { close = i + 1; break; } }
    }
    const body = open >= 0 && close > open ? WEB_UI_HTML.slice(open, close) : "";
    ok(
      "addMsg() routes both roles through md() (user markdown renders)",
      /var\s+html\s*=\s*md\(/.test(body),
    );
    ok(
      "addMsg() no longer hand-escapes only for the user role",
      !/role\s*===\s*["']user["']\s*\?\s*["']<p>["']/.test(body),
    );
  }
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
