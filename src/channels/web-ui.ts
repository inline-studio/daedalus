// The daedalus web chat UI — a single, zero-dependency HTML document served by the web
// channel at GET /. It talks to the same channel API the page is served from:
//   GET  /history?externalUserId=…   → replay recent session messages on load
//   POST /messages                   → send a message (+ base64 file attachments)
//   GET  /events?externalUserId=…    → SSE stream of replies (text + attachments)
//
// Auth: if the channel has a bearer token, the page loads unauthenticated but the API
// calls carry it (Authorization header for fetch; ?token=… for the EventSource, which
// can't set headers). The token + a per-browser externalUserId live in localStorage.
//
// The embedded <script> deliberately avoids backtick template literals and ${…} so this
// whole document nests cleanly inside the TS template string below.
export const WEB_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Daedalus</title>
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
  #log { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
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
</style>
</head>
<body>
  <header>
    <b>Daedalus</b><span class="meta" id="status">connecting…</span>
    <span class="sp"></span>
    <button id="gear">settings</button>
  </header>
  <div id="settings">
    <label>Bearer token (if your server requires one)</label>
    <input id="token" type="password" placeholder="leave blank if none" style="min-width:240px" />
    <button id="save">save</button>
    <span class="meta" id="uid"></span>
  </div>
  <div id="log"><div class="empty">No messages yet. Say hello.</div></div>
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

  var $ = function (id) { return document.getElementById(id); };
  var log = $("log"), chips = $("chips"), statusEl = $("status");

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
    // paragraphs / line breaks for the rest
    h = h.split(/\\n{2,}/).map(function (para) {
      if (/^\\s*<(h2|h3|ul|pre)/.test(para)) return para;
      return "<p>" + para.replace(/\\n/g, "<br>") + "</p>";
    }).join("");
    h = h.replace(/\\u0000(\\d+)\\u0000/g, function (_, i) { return blocks[+i]; });
    return h;
  }

  function attachmentHtml(a) {
    if (!a || !a.base64) return "";
    var src = "data:" + (a.mediaType || "application/octet-stream") + ";base64," + a.base64;
    if ((a.mediaType || "").indexOf("image/") === 0) return '<img src="' + src + '" alt="' + esc(a.filename || "image") + '">';
    return '<a class="file" href="' + src + '" download="' + esc(a.filename || "file") + '">⬇ ' + esc(a.filename || "file") + "</a>";
  }

  function addMsg(role, text, attachments) {
    var empty = log.querySelector(".empty"); if (empty) empty.remove();
    var div = document.createElement("div");
    div.className = "msg " + (role === "user" ? "user" : "assistant");
    var html = role === "user" ? "<p>" + esc(text || "").replace(/\\n/g, "<br>") + "</p>" : md(text || "");
    (attachments || []).forEach(function (a) { html += attachmentHtml(a); });
    div.innerHTML = html;
    log.appendChild(div); log.scrollTop = log.scrollHeight;
    return div;
  }

  function connect() {
    if (es) es.close();
    var u = "/events?externalUserId=" + encodeURIComponent(uid) + (token ? "&token=" + encodeURIComponent(token) : "");
    es = new EventSource(u);
    es.onopen = function () { statusEl.textContent = "connected"; };
    es.onerror = function () { statusEl.textContent = "reconnecting…"; };
    es.addEventListener("message", function (ev) {
      try { var d = JSON.parse(ev.data); addMsg("assistant", d.text || "", d.attachments || []); } catch (e) {}
    });
  }

  function loadHistory() {
    fetch("/history?externalUserId=" + encodeURIComponent(uid), { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : { messages: [] }; })
      .then(function (j) { (j.messages || []).forEach(function (m) { addMsg(m.role, m.text || "", m.attachments || []); }); })
      .catch(function () {});
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
      .then(function (r) { if (!r.ok) statusEl.textContent = "send failed (" + r.status + ")"; })
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
