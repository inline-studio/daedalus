// The daedalus web chat UI — a single, zero-dependency HTML document served by the web
// channel at GET /. It talks to the same channel API the page is served from:
//   GET  /history?externalUserId=…   → replay recent session messages on load
//   POST /messages                   → send a message (+ base64 file attachments)
//   GET  /events?externalUserId=…    → SSE stream of replies (text + attachments)
//
// Auth (one of three modes, chosen by the server and injected as __DAE_WEB_MODE__):
//   - "login": the channel has its own username/password login (WEB_LOGIN_HTML at /login). A
//     signed httpOnly cookie carries auth — sent automatically with fetch + EventSource — so
//     there's no bearer token UI and the server derives the user from the cookie. Header shows
//     a Logout button instead of settings.
//   - "token": a bearer token gates the API (Authorization header for fetch; ?token=… for the
//     EventSource, which can't set headers). The token + a per-browser externalUserId live in
//     localStorage; the gear settings expose the token field.
//   - "open": no auth.
//
// Notifications: opt-in via the 🔔 button (Notification permission). When the tab isn't focused
// and a reply arrives over SSE, a browser notification fires.
//
// The embedded <script> deliberately avoids backtick template literals and ${…} so this
// whole document nests cleanly inside the TS template string below.
export const WEB_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Daedalus</title>
<!-- Favicon: an inline SVG of a square-spiral labyrinth (Daedalus built the Labyrinth),
     in the UI accent blue. Inlined as a data URI so the UI stays a single self-contained file. -->
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNyIgZmlsbD0iIzBkMTExNyIvPjxwYXRoIGQ9Ik01IDI3VjVIMjdWMjdIMTBWMTBIMjJWMjJIMTYiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzU4YTZmZiIgc3Ryb2tlLXdpZHRoPSIyLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvc3ZnPg==" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background: #0d1117; color: #e6edf3; height: 100dvh; display: flex; flex-direction: column; }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 14px;
           border-bottom: 1px solid #21262d; background: #161b22; }
  header b { font-weight: 600; }
  header .sp { flex: 1; }
  header button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px;
                  padding: 5px 10px; cursor: pointer; font-size: 13px; }
  header button:hover { background: #30363d; }
  #settings { display: none; padding: 10px 14px; border-bottom: 1px solid #21262d; background: #161b22; gap: 8px; }
  #settings.on { display: flex; flex-wrap: wrap; align-items: center; }
  #settings input { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; }
  #settings label { font-size: 13px; color: #9da7b3; }
  /* Chat-app convention: messages anchored to the BOTTOM. Without
     justify-content: flex-end, a short conversation stacks at the top of #log
     with empty space underneath — the latest message floats mid-page,
     "where did everything go" — and there's no scrollbar because content
     fits the container. flex-end fills from the bottom up, which both
     matches user expectation AND keeps the scroll-on-overflow behaviour. */
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex;
         flex-direction: column; justify-content: flex-end; gap: 12px; }
  /* When a child grows the flex container, justify-content can clip the
     top of the first item. min-height on each .msg avoids that and keeps
     scrolling correct in tall conversations. */
  #log > * { flex-shrink: 0; }
  .msg { max-width: 760px; width: fit-content; padding: 10px 14px; border-radius: 12px; white-space: normal; word-wrap: break-word; }
  .msg.user { align-self: flex-end; background: #1f6feb; color: #fff; border-bottom-right-radius: 4px; }
  .msg.assistant { align-self: flex-start; background: #161b22; border: 1px solid #21262d; border-bottom-left-radius: 4px; }
  .msg p { margin: 0 0 8px; } .msg p:last-child { margin-bottom: 0; }
  .msg pre { background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 10px; overflow-x: auto; }
  .msg code { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 1px 4px; font-size: 13px; }
  .msg pre code { background: none; border: none; padding: 0; }
  .msg.user code, .msg.user pre { background: rgba(0,0,0,.25); border-color: rgba(255,255,255,.2); }
  .msg img { max-width: 100%; border-radius: 8px; margin-top: 6px; }
  .msg a.file { display: inline-block; margin-top: 6px; color: #58a6ff; }
  .msg table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; max-width: 100%; }
  .msg th, .msg td { border: 1px solid #30363d; padding: 6px 10px; text-align: left; vertical-align: top; }
  .msg th { background: #0d1117; font-weight: 600; }
  .msg.user th { background: rgba(0,0,0,.25); }
  .msg.user th, .msg.user td { border-color: rgba(255,255,255,.2); }
  .meta { font-size: 11px; color: #8b949e; margin: 0 4px; }
  footer { border-top: 1px solid #21262d; background: #161b22; padding: 10px 14px; }
  #chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  #chips .chip { background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 3px 8px; font-size: 12px; }
  #chips .chip b { cursor: pointer; margin-left: 6px; color: #f85149; }
  .row { display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; resize: none; background: #0d1117; color: #e6edf3; border: 1px solid #30363d;
             border-radius: 8px; padding: 9px 12px; font: inherit; max-height: 180px; }
  .row button, .row label.attach { background: #238636; color: #fff; border: 1px solid #2ea043; border-radius: 8px;
             padding: 9px 14px; cursor: pointer; font: inherit; }
  .row label.attach { background: #21262d; border-color: #30363d; }
  .row button:disabled { opacity: .5; cursor: default; }
  .empty { color: #8b949e; text-align: center; margin: auto; }
  /* "New messages below" pill — appears in the log when new messages arrive
     while the user has scrolled up; clicking it jumps to the bottom. The
     auto-scroll-to-bottom-on-every-message behaviour used to make it
     impossible to read older history while the agent was actively replying. */
  #new-pill { position: fixed; bottom: 92px; left: 50%; transform: translateX(-50%);
              background: #1f6feb; color: #fff; border: 1px solid #388bfd; border-radius: 999px;
              padding: 6px 14px; font: inherit; font-size: 13px; cursor: pointer;
              box-shadow: 0 4px 12px rgba(0,0,0,.4); display: none; z-index: 10; }
  #new-pill:hover { background: #388bfd; }
  #new-pill.on { display: block; }
</style>
</head>
<body>
  <header>
    <b>Daedalus</b><span class="meta" id="status">connecting…</span>
    <span class="sp"></span>
    <button id="notify" title="Notify me when Artemis replies and this tab isn't focused">🔔 off</button>
    <button id="gear">settings</button>
    <button id="logout" style="display:none">logout</button>
  </header>
  <div id="settings">
    <label>Bearer token (if your server requires one)</label>
    <input id="token" type="password" placeholder="leave blank if none" style="min-width:240px" />
    <button id="save">save</button>
    <span class="meta" id="uid"></span>
  </div>
  <div id="log"><div class="empty">No messages yet. Say hello.</div></div>
  <button id="new-pill" type="button">↓ new messages</button>
  <footer>
    <div id="chips"></div>
    <div class="row">
      <textarea id="text" rows="1" placeholder="Message Artemis…  (Enter to send, Shift+Enter for newline)"></textarea>
      <label class="attach" title="Attach files">📎<input id="file" type="file" multiple hidden /></label>
      <button id="send">Send</button>
    </div>
  </footer>
<script>
(function () {
  var LS = window.localStorage;
  var uid = LS.getItem("dae_uid");
  if (!uid) { uid = "web-" + Math.random().toString(36).slice(2) + Date.now().toString(36); LS.setItem("dae_uid", uid); }
  var token = LS.getItem("dae_token") || "";
  var pending = []; // [{kind, mediaType, filename, base64}]
  var es = null;
  // Injected by the server: "login" (cookie auth — no token UI), "token", or "open".
  var MODE = "__DAE_WEB_MODE__";
  var notifyOn = LS.getItem("dae_notify") === "1";
  var iconEl = document.querySelector("link[rel=icon]");
  var FAVICON = iconEl ? iconEl.href : "";

  var $ = function (id) { return document.getElementById(id); };
  var log = $("log"), chips = $("chips"), statusEl = $("status");

  // In login mode the session cookie carries auth (sent automatically with fetch/EventSource),
  // so there's no bearer token and the server derives the user from the cookie. Hide the token
  // settings and offer Logout instead.
  if (MODE === "login") {
    token = "";
    var gear = $("gear"); if (gear) gear.style.display = "none";
    var lo = $("logout");
    if (lo) {
      lo.style.display = "";
      lo.addEventListener("click", function () {
        fetch("/logout", { method: "POST" }).then(gotoLogin, gotoLogin);
      });
    }
  }
  function gotoLogin() { location.href = "/login"; }
  // If the session lapses mid-use, a protected call 401s — bounce to the login page.
  function on401(r) { if (MODE === "login" && r && r.status === 401) { gotoLogin(); return true; } return false; }

  // Browser notification when a reply lands and the tab isn't focused (opt-in; see the 🔔 button).
  function maybeNotify(text) {
    if (!notifyOn || !("Notification" in window) || Notification.permission !== "granted") return;
    if (!document.hidden) return; // tab is focused — no need to nag
    try {
      var n = new Notification("Artemis replied", { body: (text || "").slice(0, 140), icon: FAVICON });
      n.onclick = function () { window.focus(); n.close(); };
    } catch (e) {}
  }
  function renderNotifyBtn() {
    var b = $("notify");
    if (!b) return;
    if (!("Notification" in window)) { b.style.display = "none"; return; }
    b.textContent = (notifyOn && Notification.permission === "granted") ? "🔔 on" : "🔔 off";
  }
  $("notify").addEventListener("click", function () {
    if (!("Notification" in window)) return;
    if (Notification.permission === "default") {
      Notification.requestPermission().then(function (p) {
        notifyOn = (p === "granted"); LS.setItem("dae_notify", notifyOn ? "1" : "0"); renderNotifyBtn();
      });
    } else if (Notification.permission === "granted") {
      notifyOn = !notifyOn; LS.setItem("dae_notify", notifyOn ? "1" : "0"); renderNotifyBtn();
    } else {
      statusEl.textContent = "notifications are blocked in your browser settings";
    }
  });
  renderNotifyBtn();

  function authHeaders() { var h = { "content-type": "application/json" }; if (token) h["authorization"] = "Bearer " + token; return h; }

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }

  // Minimal Markdown → HTML (escape first, then a safe subset).
  function md(src) {
    var blocks = [];
    var h = esc(src == null ? "" : src);
    h = h.replace(/\\\`\\\`\\\`([\\s\\S]*?)\\\`\\\`\\\`/g, function (_, c) {
      blocks.push("<pre><code>" + c.replace(/^\\n/, "") + "</code></pre>"); return "\\u0000" + (blocks.length - 1) + "\\u0000";
    });
    h = h.replace(/\\\`([^\\\`]+)\\\`/g, "<code>$1</code>");
    h = h.replace(/^### (.*)$/gm, "<h3>$1</h3>").replace(/^## (.*)$/gm, "<h2>$1</h2>").replace(/^# (.*)$/gm, "<h2>$1</h2>");
    h = h.replace(/\\*\\*([^*]+)\\*\\*/g, "<strong>$1</strong>").replace(/\\*([^*]+)\\*/g, "<em>$1</em>");
    h = h.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    // unordered lists
    h = h.replace(/(?:^|\\n)((?:- .*(?:\\n|$))+)/g, function (m, list) {
      var items = list.trim().split(/\\n/).map(function (li) { return "<li>" + li.replace(/^- /, "") + "</li>"; }).join("");
      return "\\n<ul>" + items + "</ul>";
    });
    // paragraphs / line breaks for the rest. A paragraph block that LOOKS
    // like a GFM table (first line is pipe-delimited, second line is a
    // dash-and-pipe separator) becomes a real <table>; otherwise wraps in <p>.
    h = h.split(/\\n{2,}/).map(function (para) {
      if (/^\\s*<(h2|h3|ul|pre)/.test(para)) return para;
      var tbl = renderTable(para);
      if (tbl) return tbl;
      return "<p>" + para.replace(/\\n/g, "<br>") + "</p>";
    }).join("");
    h = h.replace(/\\u0000(\\d+)\\u0000/g, function (_, i) { return blocks[+i]; });
    return h;
  }

  // Render a GFM table block to a <table> element, or return null when the
  // block isn't one. Called by md() per paragraph block — runs AFTER
  // htmlEscape, so the input pipe chars are still raw.
  // Expected shape:
  //   | header1 | header2 |
  //   |---------|---------|
  //   | cell    | cell    |
  // Separator row tolerates spaces and colon alignment markers; both leading
  // and trailing pipes are required (matches what Claude emits).
  function renderTable(block) {
    var lines = block.split(/\\n/).map(function (l) { return l.trim(); }).filter(Boolean);
    if (lines.length < 2) return null;
    var hdr = lines[0], sep = lines[1];
    if (!/^\\|.+\\|$/.test(hdr)) return null;
    if (!/^\\|[\\s:|-]+\\|$/.test(sep)) return null;
    // Header pipe count must equal separator pipe count, otherwise it's a
    // false positive (e.g. a code-snippet-looking line followed by an
    // unrelated dashes row).
    if ((hdr.match(/\\|/g) || []).length !== (sep.match(/\\|/g) || []).length) return null;
    function cells(line) {
      return line.slice(1, -1).split("|").map(function (c) { return c.trim(); });
    }
    var headers = cells(hdr);
    var bodyLines = lines.slice(2);
    // Strict: every post-separator line must be a pipe row. Mixing prose into
    // the block would otherwise be silently dropped when we replace the whole
    // block with <table>. Bail out and let it render as a normal paragraph.
    for (var i = 0; i < bodyLines.length; i++) {
      if (!/^\\|.+\\|$/.test(bodyLines[i])) return null;
    }
    var thead = "<thead><tr>" + headers.map(function (h) { return "<th>" + h + "</th>"; }).join("") + "</tr></thead>";
    var tbody = "<tbody>" + bodyLines.map(function (l) {
      var c = cells(l);
      // Pad/truncate to the header column count so a row with extra/missing
      // pipes doesn't break alignment.
      while (c.length < headers.length) c.push("");
      if (c.length > headers.length) c = c.slice(0, headers.length);
      return "<tr>" + c.map(function (x) { return "<td>" + x + "</td>"; }).join("") + "</tr>";
    }).join("") + "</tbody>";
    return "<table>" + thead + tbody + "</table>";
  }

  function attachmentHtml(a) {
    if (!a || !a.base64) return "";
    var src = "data:" + (a.mediaType || "application/octet-stream") + ";base64," + a.base64;
    if ((a.mediaType || "").indexOf("image/") === 0) return '<img src="' + src + '" alt="' + esc(a.filename || "image") + '">';
    return '<a class="file" href="' + src + '" download="' + esc(a.filename || "file") + '">⬇ ' + esc(a.filename || "file") + "</a>";
  }

  // Smart auto-scroll. The previous behaviour ("scroll to bottom on every new
  // message") made it impossible to read older history while the agent was
  // actively replying — every new tool-step yanked the user back down. Now:
  // only scroll if the user was already AT the bottom (within 60px); otherwise
  // leave their viewport alone and show the "↓ new messages" pill so they
  // know there's new content waiting below.
  var pill = $("new-pill");
  var newSinceScrolled = 0;
  function isAtBottom() {
    return log.scrollTop + log.clientHeight >= log.scrollHeight - 60;
  }
  function jumpToBottom() {
    log.scrollTop = log.scrollHeight;
    newSinceScrolled = 0;
    pill.classList.remove("on");
    pill.textContent = "↓ new messages";
  }
  pill.addEventListener("click", jumpToBottom);
  log.addEventListener("scroll", function () { if (isAtBottom()) jumpToBottom(); });

  // True while loadHistory is bulk-loading. The smart-scroll heuristic
  // ("is user at bottom?") doesn't make sense for the initial page load —
  // there's no user there yet to be "at" anywhere. Bypass the heuristic and
  // skip the per-message scroll work; the caller (loadHistory) does a single
  // jumpToBottom() at the end of the batch.
  var bulkLoading = false;
  function addMsg(role, text, attachments) {
    var empty = log.querySelector(".empty"); if (empty) empty.remove();
    var wasAtBottom = isAtBottom();
    var div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "assistant");
    var html = role === "user" ? "<p>" + esc(text || "").replace(/\\n/g, "<br>") + "</p>" : md(text || "");
    (attachments || []).forEach(function (a) { html += attachmentHtml(a); });
    div.innerHTML = html;
    log.appendChild(div);
    if (bulkLoading) return div; // caller will scroll once at the end
    // User's own messages always jump (they just hit Enter, they want to see it).
    if (wasAtBottom || role === "user") {
      jumpToBottom();
    } else {
      newSinceScrolled++;
      pill.textContent = "↓ " + newSinceScrolled + " new message" + (newSinceScrolled === 1 ? "" : "s");
      pill.classList.add("on");
    }
    return div;
  }

  // SSE wiring. Three reliability fixes layered here:
  //
  //   1. Last-Event-ID resume (server-side, see web.ts:send + handleSse): the
  //      server tags every event with an id line; the browser auto-sends
  //      Last-Event-ID on reconnect; the server replays anything we missed.
  //      Handles the "browser dropped the connection" case.
  //
  //   2. Watchdog (this file, below): proxies (Caddy, nginx, Cloudflare) can
  //      silently tear down a long-lived SSE socket while the BROWSER still
  //      thinks it is open — onerror never fires, no auto-reconnect, messages
  //      sent to the dead socket are lost. We track when we last received ANY
  //      event (including heartbeats) and force a reconnect if the silence
  //      exceeds 45s (2+ missed heartbeats). The force-reconnect triggers (1)
  //      to replay anything missed during the dead window.
  //
  //   3. Heartbeat as a real event, not a comment: SSE comments do not
  //      surface to JS, so we could not drive the watchdog from them. The
  //      server now emits a named heartbeat event every 20s (with NO id
  //      line, so it does not disturb Last-Event-ID).
  var lastEventAt = Date.now();
  function markActivity() { lastEventAt = Date.now(); }

  function connect() {
    if (es) es.close();
    var u = "/events?externalUserId=" + encodeURIComponent(uid) + (token ? "&token=" + encodeURIComponent(token) : "");
    es = new EventSource(u);
    es.onopen = function () { statusEl.textContent = "connected"; markActivity(); };
    es.onerror = function () { statusEl.textContent = "reconnecting…"; };
    es.addEventListener("heartbeat", function () { markActivity(); });
    es.addEventListener("message", function (ev) {
      markActivity();
      var d;
      try { d = JSON.parse(ev.data); }
      catch (e) {
        // Surface the parse failure to the console instead of silently
        // swallowing — without this, a single malformed payload made it look
        // like the agent had simply stopped replying.
        console.error("SSE message JSON parse failed", e, ev.data);
        return;
      }
      addMsg("assistant", d.text || "", d.attachments || []);
      maybeNotify(d.text || "");
    });
  }

  // Watchdog: every 15s, check whether the connection has been silent too
  // long. 45s = 2+ missed heartbeats. Force a reconnect on suspicion — the
  // server's Last-Event-ID replay catches anything we missed.
  setInterval(function () {
    if (Date.now() - lastEventAt > 45_000) {
      console.warn("SSE: no event for >45s — forcing reconnect");
      statusEl.textContent = "reconnecting…";
      connect();
    }
  }, 15_000);

  function loadHistory() {
    fetch("/history?externalUserId=" + encodeURIComponent(uid), { headers: authHeaders() })
      .then(function (r) { if (on401(r)) return { messages: [] }; return r.ok ? r.json() : { messages: [] }; })
      .then(function (j) {
        // Bulk-load: bypass the smart-scroll per-message work and the "↓ N new
        // messages" pill (these are HISTORY, not new) — then snap to the
        // bottom once at the end so the user sees the most recent reply.
        bulkLoading = true;
        try { (j.messages || []).forEach(function (m) { addMsg(m.role, m.text || "", m.attachments || []); }); }
        finally { bulkLoading = false; }
        jumpToBottom();
      })
      .catch(function (err) { console.error("loadHistory failed", err); });
  }

  function fileToAttachment(file) {
    return new Promise(function (resolve) {
      var fr = new FileReader();
      fr.onload = function () {
        var b64 = String(fr.result).split(",")[1] || "";
        var kind = file.type.indexOf("image/") === 0 ? "image" : (file.type.indexOf("audio/") === 0 ? "audio" : "file");
        resolve({ kind: kind, mediaType: file.type || "application/octet-stream", filename: file.name, base64: b64 });
      };
      fr.readAsDataURL(file);
    });
  }

  function renderChips() {
    chips.innerHTML = "";
    pending.forEach(function (a, i) {
      var c = document.createElement("span"); c.className = "chip";
      c.innerHTML = esc(a.filename) + "<b data-i='" + i + "'>✕</b>";
      chips.appendChild(c);
    });
  }
  chips.addEventListener("click", function (e) {
    var i = e.target.getAttribute && e.target.getAttribute("data-i");
    if (i != null) { pending.splice(+i, 1); renderChips(); }
  });

  $("file").addEventListener("change", function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    Promise.all(files.map(fileToAttachment)).then(function (atts) { pending = pending.concat(atts); renderChips(); });
    e.target.value = "";
  });

  function send() {
    var text = $("text").value.trim();
    if (!text && !pending.length) return;
    var atts = pending.slice();
    var body = { externalUserId: uid };
    if (text) body.text = text;
    if (atts.length) body.attachments = atts;
    addMsg("user", text, atts);
    $("text").value = ""; pending = []; renderChips(); autosize();
    fetch("/messages", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      .then(function (r) { if (on401(r)) return; if (!r.ok) statusEl.textContent = "send failed (" + r.status + ")"; })
      .catch(function () { statusEl.textContent = "send failed"; });
  }

  function autosize() { var t = $("text"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; }
  $("text").addEventListener("input", autosize);
  $("text").addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
  $("send").addEventListener("click", send);

  $("gear").addEventListener("click", function () { $("settings").classList.toggle("on"); $("uid").textContent = "id: " + uid; $("token").value = token; });
  $("save").addEventListener("click", function () { token = $("token").value.trim(); LS.setItem("dae_token", token); $("settings").classList.remove("on"); connect(); });

  loadHistory();
  connect();
})();
</script>
</body>
</html>`;

// The login page served at GET /login when the channel is in "login" mode. POSTs the
// credentials to /login; on success the server sets the session cookie and we go to /.
export const WEB_LOGIN_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Daedalus — Sign in</title>
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNyIgZmlsbD0iIzBkMTExNyIvPjxwYXRoIGQ9Ik01IDI3VjVIMjdWMjdIMTBWMTBIMjJWMjJIMTYiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzU4YTZmZiIgc3Ryb2tlLXdpZHRoPSIyLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvc3ZnPg==" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
         background: #0d1117; color: #e6edf3; min-height: 100dvh; display: flex; align-items: center; justify-content: center; }
  form { background: #161b22; border: 1px solid #21262d; border-radius: 12px; padding: 28px 24px;
         width: 320px; display: flex; flex-direction: column; gap: 12px; }
  .logo { display: flex; align-items: center; gap: 10px; font-size: 20px; font-weight: 600; margin-bottom: 6px; }
  .logo img { width: 28px; height: 28px; }
  input { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 8px; padding: 10px 12px; font: inherit; }
  button { background: #238636; color: #fff; border: 1px solid #2ea043; border-radius: 8px; padding: 10px 12px;
           font: inherit; cursor: pointer; }
  button:hover { background: #2ea043; }
  .err { color: #f85149; font-size: 13px; min-height: 18px; }
</style>
</head>
<body>
  <form id="f">
    <div class="logo"><img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iNyIgZmlsbD0iIzBkMTExNyIvPjxwYXRoIGQ9Ik01IDI3VjVIMjdWMjdIMTBWMTBIMjJWMjJIMTYiIGZpbGw9Im5vbmUiIHN0cm9rZT0iIzU4YTZmZiIgc3Ryb2tlLXdpZHRoPSIyLjQiIHN0cm9rZS1saW5lY2FwPSJyb3VuZCIgc3Ryb2tlLWxpbmVqb2luPSJyb3VuZCIvPjwvc3ZnPg==" alt="" /> Daedalus</div>
    <input id="u" name="username" placeholder="Username" autocomplete="username" autofocus />
    <input id="p" name="password" type="password" placeholder="Password" autocomplete="current-password" />
    <button type="submit">Sign in</button>
    <div class="err" id="err"></div>
  </form>
<script>
(function () {
  var f = document.getElementById("f"), err = document.getElementById("err");
  f.addEventListener("submit", function (e) {
    e.preventDefault(); err.textContent = "";
    fetch("/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: document.getElementById("u").value, password: document.getElementById("p").value })
    }).then(function (r) {
      if (r.ok) { location.href = "/"; } else { err.textContent = "Invalid username or password"; }
    }).catch(function () { err.textContent = "Sign-in failed — try again"; });
  });
})();
</script>
</body>
</html>`;
