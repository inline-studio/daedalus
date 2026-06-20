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
         background: #0d1117; color: #e6edf3; height: 100dvh; display: flex; flex-direction: row; }
  /* Conversation sidebar (Claude.ai-style separate sessions). A column with a "New chat"
     button on top and the scrollable conversation list below. On narrow screens it slides
     over the chat instead of taking a column (see the media query). */
  #sidebar { width: 248px; flex-shrink: 0; display: flex; flex-direction: column;
             background: #0a0d12; border-right: 1px solid #1b212a; }
  #sidebar .sb-head { padding: 10px; border-bottom: 1px solid #1b212a; }
  #new-convo { width: 100%; background: transparent; color: #c9d1d9; border: 1px solid #2a313c;
               border-radius: 8px; padding: 9px 12px; cursor: pointer; font: inherit; }
  #new-convo:hover { background: #161b22; color: #e6edf3; }
  #convo-list { flex: 1; overflow-y: auto; padding: 6px; display: flex; flex-direction: column; gap: 2px; }
  .convo { display: flex; align-items: center; gap: 6px; padding: 8px 10px; border-radius: 8px;
           cursor: pointer; color: #c9d1d9; }
  .convo:hover { background: #161b22; }
  .convo.active { background: #1f6feb22; color: #e6edf3; }
  .convo .title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; }
  .convo .del { color: #8b949e; border: none; background: none; cursor: pointer; font-size: 13px;
                padding: 0 4px; visibility: hidden; }
  .convo:hover .del { visibility: visible; }
  .convo .del:hover { color: #f85149; }
  /* The chat column: header + log + composer, to the right of the sidebar. min-width:0 lets
     it shrink instead of overflowing the flex row. */
  #main { flex: 1; min-width: 0; height: 100dvh; display: flex; flex-direction: column; }
  /* Hamburger toggles the sidebar on narrow screens; hidden on wide ones. */
  #sb-toggle { display: none; }
  @media (max-width: 720px) {
    #sb-toggle { display: inline-block; }
    #sidebar { position: fixed; z-index: 30; top: 0; left: 0; height: 100dvh;
               transform: translateX(-100%); transition: transform .18s ease;
               box-shadow: 2px 0 12px rgba(0,0,0,.5); }
    body.sb-open #sidebar { transform: translateX(0); }
    /* Dim the chat behind the open drawer; tap it to close. */
    #sb-scrim { display: none; position: fixed; inset: 0; z-index: 20; background: rgba(0,0,0,.5); }
    body.sb-open #sb-scrim { display: block; }
  }
  header { display: flex; align-items: center; gap: 10px; padding: 9px 16px;
           border-bottom: 1px solid #1b212a; background: #0d1117; }
  header b { font-weight: 600; }
  header .sp { flex: 1; }
  header button { background: transparent; color: #c9d1d9; border: 1px solid #2a313c; border-radius: 7px;
                  padding: 5px 11px; cursor: pointer; font-size: 13px; }
  header button:hover { background: #161b22; color: #e6edf3; }
  #settings { display: none; padding: 10px 16px; border-bottom: 1px solid #1b212a; background: #0d1117; gap: 8px; }
  #settings.on { display: flex; flex-wrap: wrap; align-items: center; }
  #settings input { background: #0d1117; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px; padding: 6px 8px; }
  #settings label { font-size: 13px; color: #9da7b3; }
  /* Selection action bar (Telegram-style). Hidden until the user enters select mode; then it
     shows the count, Select all/none, Copy, and Cancel. While selecting, message bubbles are
     tappable to toggle and the selected ones get a blue ring. */
  #selbar { display: none; padding: 8px 16px; border-bottom: 1px solid #1b212a; background: #0d1117;
            align-items: center; gap: 10px; }
  #selbar.on { display: flex; }
  #selbar button { background: #21262d; color: #e6edf3; border: 1px solid #30363d; border-radius: 6px;
                   padding: 5px 10px; cursor: pointer; font-size: 13px; }
  #selbar button:hover { background: #30363d; }
  #selbar #sel-copy { background: #238636; border-color: #2ea043; color: #fff; }
  #selbar #sel-copy:disabled { opacity: .5; cursor: default; }
  body.selecting .msg { cursor: pointer; }
  /* The ring sits inside the bubble's box so it doesn't get clipped by the log's overflow. */
  .msg.selected { box-shadow: inset 0 0 0 2px #58a6ff; }
  /* Telegram-style tick badge on a selected bubble — the ring alone is hard to see on the
     blue user bubbles, so a green check circle makes selection unambiguous on any bubble
     colour. Anchored to the bubble's top-leading corner, just outside it; the page-coloured
     border lifts it off the bubble. (.msg is position:relative so this anchors to it.) */
  .msg.selected::after { content: "✓"; position: absolute; top: -8px; width: 20px; height: 20px;
                         display: flex; align-items: center; justify-content: center;
                         background: #238636; color: #fff; border: 2px solid #0d1117;
                         border-radius: 50%; font-size: 12px; line-height: 1; z-index: 2; }
  /* User bubbles are right-aligned → badge on their left; assistant bubbles left-aligned →
     badge on their right, so it always sits in the gutter, never over the text. */
  .msg.user.selected::after { left: -8px; }
  .msg.assistant.selected::after { right: -8px; }
  /* Chat-app convention: messages anchored to the BOTTOM. A previous
     iteration used justify-content: flex-end here, which works when content
     fits the container but has a long-standing Chromium bug when content
     OVERFLOWS — the top of the content becomes unreachable and the scrollbar
     never appears. (Brave on macOS reproduces this reliably.)
     The robust pattern is margin-top: auto on the first child: it absorbs
     extra space when the conversation is short (anchors to bottom), and
     collapses to 0 when the content overflows (native scroll works as the
     browser expects). The flex column + overflow-y: auto stay the same. */
  #log { flex: 1; overflow-y: auto; padding: 20px 18px; display: flex;
         flex-direction: column; gap: 18px;
         /* Reserve the scrollbar gutter so the layout doesn't shift sideways when the bar
            appears/disappears mid-stream (the horizontal "wobble"). */
         scrollbar-gutter: stable; }
  #log > :first-child { margin-top: auto; }
  /* Flex children can be shrunk by default, which would let the browser
     compress tall message bubbles instead of letting #log scroll. Lock
     their intrinsic size so scroll behaviour is predictable. */
  #log > * { flex-shrink: 0; }
  /* max-width clamps to the viewport on mobile (min(760px,100%)) and min-width:0 lets the bubble
     shrink below its content's intrinsic width — so a wide table/code block scrolls WITHIN the
     bubble (it has overflow-x:auto) instead of pushing the whole message past the screen edge. */
  .msg { position: relative; max-width: min(760px, 100%); min-width: 0; width: fit-content;
         white-space: normal; word-wrap: break-word; }
  /* Block containers inside the reply must also be allowed to shrink, or a wide child re-expands
     them past the bubble. */
  .reply-block, .stream-prose, .stream-mono, .turn-meta { min-width: 0; max-width: 100%; }
  .msg pre { max-width: 100%; }
  .msg.user { align-self: flex-end; background: #1f6feb; color: #fff; padding: 9px 13px;
              border-radius: 16px; border-bottom-right-radius: 5px; }
  /* Assistant replies are borderless — plain text, not a boxed bubble — for a lighter, modern
     feel (à la ChatGPT/Claude). Only the user's own messages get a bubble. */
  .msg.assistant { align-self: flex-start; background: transparent; padding: 0; line-height: 1.6; }
  .msg p { margin: 0 0 8px; } .msg p:last-child { margin-bottom: 0; }
  .msg pre { position: relative; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; padding: 10px; padding-right: 60px; overflow-x: auto; }
  .msg code { background: #0d1117; border: 1px solid #30363d; border-radius: 4px; padding: 1px 4px; font-size: 13px; }
  .msg pre code { background: none; border: none; padding: 0; }
  /* Copy button on every <pre><code> block. Always visible (not hover-only)
     so it works on touch too. padding-right above leaves room for it. */
  .copy-btn { position: absolute; top: 6px; right: 6px;
              background: #21262d; color: #e6edf3; border: 1px solid #30363d;
              border-radius: 6px; padding: 2px 8px; font-size: 12px;
              font-family: inherit; cursor: pointer; line-height: 1.4; }
  .copy-btn:hover { background: #30363d; }
  .copy-btn.copied { background: #238636; border-color: #2ea043; color: #fff; }
  .msg.user code, .msg.user pre { background: rgba(0,0,0,.25); border-color: rgba(255,255,255,.2); }
  /* System notices (e.g. "conversation compacted" markers replayed from /history) —
     centered, dashed, muted: clearly not something either party said. */
  .msg.notice { align-self: center; background: transparent; border: 1px dashed #30363d;
                color: #8b949e; font-size: 12px; max-width: 640px; padding: 8px 12px; border-radius: 10px; }
  /* Activity chrome — tool calls, reasoning, debug pointers. Deliberately subordinate to the
     reply itself: muted, small, pill/inset styling so they read as "what the assistant did",
     not "what it said". A .chrome row holds the chips; .reasoning is a quieter inset block. */
  .chrome { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-bottom: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; line-height: 1.4;
          color: #8b949e; background: #12161c; border: 1px solid #21262d; border-radius: 999px;
          padding: 3px 10px; }
  .chip .dot { width: 6px; height: 6px; border-radius: 50%; background: #539bf5; flex-shrink: 0; }
  .chip .k { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #adbac7; }
  .chip.debug { cursor: pointer; }
  .chip.debug .dot { background: #6e7681; }
  .chip.debug:hover { color: #c9d1d9; border-color: #30363d; }
  /* Reasoning: a collapsible "💭 Thinking" disclosure, deliberately unlike the reply — muted,
     italic, smaller, behind a header — so it reads as the model's scratchpad, not the answer. */
  .reasoning { margin: 6px 0; }
  .reasoning .rhead { display: inline-flex; align-items: center; gap: 6px; cursor: pointer;
                      font-size: 12px; color: #6e7681; user-select: none; }
  .reasoning .rhead .chev { font-size: 10px; color: #6e7681; }
  .reasoning .rbody { border-left: 2px solid #2a313c; margin: 4px 0 0 4px; padding: 2px 0 2px 10px;
                      color: #6e7681; font-size: 12.5px; font-style: italic; line-height: 1.5;
                      white-space: pre-wrap; }
  .reasoning.collapsed .rbody { display: none; }
  /* In-progress streamed reply: raw text typed out, swapped for rendered markdown when the turn
     completes. Prose stays proportional/normal; only code fences and table rows go monospace (so
     they stay aligned and read as code), slightly muted to signal "being written". */
  .stream-prose { white-space: pre-wrap; line-height: 1.6; }
  .stream-mono { white-space: pre-wrap; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                 font-size: 13px; line-height: 1.5; color: #adbac7; }
  /* Claude-style tool-call rows: a collapsible header (name + primary-arg summary + state) that
     expands to the full input. Running = "…", resolved = ✓ / ✗. */
  /* Tool rows sit inline in the reply flow (chronological), each with its own vertical margin. */
  .tool-call { border: 1px solid #21262d; border-radius: 8px; background: #0d1117; overflow: hidden; max-width: 560px; margin: 6px 0; }
  .reply-block + .tool-call, .tool-call + .reply-block, .reasoning + .tool-call { margin-top: 8px; }
  .tool-call .head { display: flex; align-items: center; gap: 8px; padding: 6px 10px; cursor: pointer; font-size: 12.5px; }
  .tool-call .head:hover { background: #12161c; }
  .tool-call .chev { color: #6e7681; width: 10px; flex-shrink: 0; }
  .tool-call .label { color: #8b949e; flex-shrink: 0; }
  .tool-call .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #adbac7; }
  .tool-call .sum { color: #6e7681; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; min-width: 0;
                    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; }
  .tool-call .state { flex-shrink: 0; font-size: 11px; color: #6e7681; }
  .tool-call.ok .state { color: #3fb950; }
  .tool-call.err .state { color: #f85149; }
  .tool-call .detail { display: none; border-top: 1px solid #21262d; padding: 8px 10px; }
  .tool-call.open .detail { display: block; }
  .tool-call .detail pre { margin: 0; white-space: pre-wrap; word-break: break-all;
                           font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11.5px; color: #adbac7; }
  .msg img { max-width: 100%; border-radius: 8px; margin-top: 6px; }
  .msg a.file { display: inline-block; margin-top: 6px; color: #58a6ff; }
  .msg table { border-collapse: collapse; margin: 8px 0; display: block; overflow-x: auto; max-width: 100%; }
  .msg th, .msg td { border: 1px solid #30363d; padding: 6px 10px; text-align: left; vertical-align: top; }
  .msg th { background: #0d1117; font-weight: 600; }
  .msg.user th { background: rgba(0,0,0,.25); }
  .msg.user th, .msg.user td { border-color: rgba(255,255,255,.2); }
  /* "Thinking…" indicator — an assistant-aligned bubble with three pulsing dots,
     shown between sending a message and the first reply event (replies can take
     ~30s, and without this the UI looked frozen). It is purely a DOM element in
     the log (id #thinking); it is never recorded into the convo transcript. */
  .msg.thinking { display: flex; gap: 5px; align-items: center; padding: 14px 16px; }
  .msg.thinking i { width: 7px; height: 7px; border-radius: 50%; background: #8b949e;
                    animation: think 1.4s infinite ease-in-out both; }
  .msg.thinking i:nth-child(2) { animation-delay: .2s; }
  .msg.thinking i:nth-child(3) { animation-delay: .4s; }
  @keyframes think { 0%, 80%, 100% { opacity: .3; transform: translateY(0); }
                     40% { opacity: 1; transform: translateY(-4px); } }
  .meta { font-size: 11px; color: #8b949e; margin: 0 4px; }
  /* Live turn timer (next to the thinking dots) + per-reply footer with elapsed time / tokens. */
  .thinking .elapsed { font-size: 12px; color: #6e7681; margin-left: 6px; }
  .turn-meta { font-size: 11px; color: #6e7681; margin-top: 6px; font-variant-numeric: tabular-nums; }
  footer { position: relative; border-top: 1px solid #1b212a; background: #0d1117; padding: 12px 16px; }
  /* Slash-command autocomplete — floats above the input while the draft is a lone "/prefix";
     ↑/↓ choose, Tab/Enter complete, Esc dismisses. Populated from GET /commands. */
  #cmd-menu { position: absolute; bottom: calc(100% + 4px); left: 14px; right: 14px;
              background: #161b22; border: 1px solid #30363d; border-radius: 8px;
              box-shadow: 0 -4px 16px rgba(0,0,0,.4); overflow: hidden; display: none; z-index: 11; }
  #cmd-menu.on { display: block; }
  #cmd-menu .item { display: flex; gap: 10px; align-items: baseline; padding: 8px 12px; cursor: pointer; }
  #cmd-menu .item.active { background: #21262d; }
  #cmd-menu .item .name { font-weight: 600; }
  #cmd-menu .item .desc { color: #8b949e; font-size: 12px; overflow: hidden;
                          text-overflow: ellipsis; white-space: nowrap; }
  #chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 6px; }
  #chips .chip { background: #21262d; border: 1px solid #30363d; border-radius: 6px; padding: 3px 8px; font-size: 12px; }
  #chips .chip b { cursor: pointer; margin-left: 6px; color: #f85149; }
  .row { display: flex; gap: 8px; align-items: flex-end; }
  textarea { flex: 1; resize: none; background: #161b22; color: #e6edf3; border: 1px solid #2a313c;
             border-radius: 12px; padding: 10px 14px; font: inherit; max-height: 180px; }
  textarea:focus { outline: none; border-color: #3d4754; }
  .row button, .row label.attach { background: #238636; color: #fff; border: 1px solid #2ea043; border-radius: 10px;
             padding: 10px 15px; cursor: pointer; font: inherit; }
  .row label.attach { background: transparent; border-color: #2a313c; color: #c9d1d9; }
  .row label.attach:hover { background: #161b22; }
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
  <div id="sb-scrim"></div>
  <aside id="sidebar">
    <div class="sb-head"><button id="new-convo" type="button">＋ New chat</button></div>
    <div id="convo-list"></div>
  </aside>
  <div id="main">
  <header>
    <button id="sb-toggle" title="Conversations">☰</button>
    <b>Daedalus</b><span class="meta" id="status">connecting…</span>
    <span class="sp"></span>
    <button id="select" title="Select messages to copy (with who-said-what + timestamps)">☑️ select</button>
    <button id="notify" title="Notify me when Artemis replies and this tab isn't focused">🔔 off</button>
    <button id="gear">settings</button>
    <button id="logout" style="display:none">logout</button>
  </header>
  <div id="selbar">
    <button id="sel-cancel" type="button">Cancel</button>
    <span class="meta" id="sel-count">0 selected</span>
    <span class="sp"></span>
    <button id="sel-all" type="button">Select all</button>
    <button id="sel-copy" type="button">📋 Copy</button>
  </div>
  <div id="settings">
    <label>Bearer token (if your server requires one)</label>
    <input id="token" type="password" placeholder="leave blank if none" style="min-width:240px" />
    <button id="save">save</button>
    <span class="meta" id="uid"></span>
  </div>
  <div id="log"><div class="empty">No messages yet. Say hello.</div></div>
  <button id="new-pill" type="button">↓ new messages</button>
  <footer>
    <div id="cmd-menu"></div>
    <div id="chips"></div>
    <div class="row">
      <textarea id="text" rows="1" placeholder="Message Artemis…  (Enter to send, Shift+Enter for newline)"></textarea>
      <label class="attach" title="Attach files">📎<input id="file" type="file" multiple hidden /></label>
      <button id="send">Send</button>
    </div>
  </footer>
  </div>
<script>
(function () {
  var LS = window.localStorage;
  var uid = LS.getItem("dae_uid");
  if (!uid) { uid = "web-" + Math.random().toString(36).slice(2) + Date.now().toString(36); LS.setItem("dae_uid", uid); }
  var token = LS.getItem("dae_token") || "";
  var pending = []; // [{kind, mediaType, filename, base64}]
  var es = null;
  // Separate conversations (Claude.ai-style). convId is the active conversation (session id);
  // defaultConvId is the "Main" session shared with other channels — tracked so it can be
  // filtered OUT of the sidebar (web shows only its own conversations). conversations holds
  // the sidebar list ([{id, title, createdAt, lastActiveAt}]). The active id is remembered in
  // localStorage so a reload reopens the same conversation.
  var convId = LS.getItem("dae_conv") || "";
  var defaultConvId = "";
  var conversations = [];
  // Injected by the server: "login" (cookie auth — no token UI), "token", or "open".
  var MODE = "__DAE_WEB_MODE__";
  // Speaker labels for the "copy chat" transcript, injected by the server (identity name +
  // the resolved human label). The chat bubbles don't use these — only the export does.
  var ASSISTANT_NAME = "__DAE_ASSISTANT_NAME__";
  var USER_NAME = "__DAE_USER_NAME__";
  // Running record of the visible conversation: [{role, text, at}] in display order. Fed by
  // addMsg (history, live replies, and the user's own sends) and consumed by "copy chat".
  var convo = [];
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
      var n = new Notification(ASSISTANT_NAME + " replied", { body: (text || "").slice(0, 140), icon: FAVICON });
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
      blocks.push("<pre><button class=\\"copy-btn\\" type=\\"button\\">Copy</button><code>" + c.replace(/^\\n/, "") + "</code></pre>"); return "\\u0000" + (blocks.length - 1) + "\\u0000";
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
  // Scroll listener: ONLY update the "↓ new messages" pill state when the user
  // returns to the bottom. The previous version called jumpToBottom() here,
  // which snapped the scroll position back to the bottom on any upward scroll
  // within the 60px isAtBottom threshold — a light upward scroll was yanked
  // back, only a hard scroll would actually move. The auto-scroll-on-new-
  // message logic lives in addMsg; this listener has no business touching
  // scrollTop.
  log.addEventListener("scroll", function () {
    if (isAtBottom()) {
      newSinceScrolled = 0;
      pill.classList.remove("on");
      pill.textContent = "↓ new messages";
    }
  });

  // Copy text to the clipboard, resolving true/false. navigator.clipboard is HTTPS-only;
  // on plain http (localhost dev) it's still available, but on a custom-domain HTTP setup
  // it'll be undefined — so fall back to a hidden textarea + execCommand("copy"). Shared by
  // the per-code-block Copy buttons and the "copy chat" transcript export.
  function copyToClipboard(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(false); });
      } else {
        try {
          var ta = document.createElement("textarea");
          ta.value = text;
          ta.style.position = "fixed"; ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          var ok = document.execCommand("copy");
          document.body.removeChild(ta);
          resolve(ok);
        } catch (_err) { resolve(false); }
      }
    });
  }

  // Attributed-transcript formatting. Each visible message becomes one line:
  //   [DD/MM/YYYY HH:MM] Name: message
  // fmtTs renders the message's timestamp (history createdAt / SSE event id / send time) in
  // local time, tolerating a missing or garbled value rather than printing "NaN".
  function pad2(n) { return (n < 10 ? "0" : "") + n; }
  function fmtTs(iso) {
    var d = iso ? new Date(iso) : new Date();
    if (isNaN(d.getTime())) d = new Date(); // tolerate a missing/garbled timestamp
    return pad2(d.getDate()) + "/" + pad2(d.getMonth() + 1) + "/" + d.getFullYear() +
           " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function lineFor(m) {
    var who = m.role === "user" ? USER_NAME : ASSISTANT_NAME;
    return "[" + fmtTs(m.at) + "] " + who + ": " + (m.text || "");
  }

  // --- Selection mode (Telegram-style) ---------------------------------------------------
  // Enter via the header "select" button; tap message bubbles to tick them; the action bar
  // offers Select all/none, Copy (the attributed transcript of the ticked messages), and
  // Cancel. Each .msg carries a data-idx into the convo array, so a selection maps straight
  // to the recorded {role, text, at} without re-parsing the rendered HTML.
  var selecting = false;
  var selected = new Set();
  function msgEls() { return log.querySelectorAll(".msg"); }
  function updateSelBar() {
    $("sel-count").textContent = selected.size + " selected";
    $("sel-copy").disabled = selected.size === 0;
    var total = msgEls().length;
    $("sel-all").textContent = total > 0 && selected.size >= total ? "Select none" : "Select all";
  }
  function enterSelect() {
    selecting = true;
    document.body.classList.add("selecting");
    $("selbar").classList.add("on");
    updateSelBar();
  }
  function exitSelect() {
    selecting = false;
    selected.clear();
    document.body.classList.remove("selecting");
    $("selbar").classList.remove("on");
    Array.prototype.forEach.call(log.querySelectorAll(".msg.selected"), function (el) { el.classList.remove("selected"); });
  }
  function toggleMsg(div) {
    var raw = div.getAttribute("data-idx");
    if (raw == null) return;
    var idx = +raw;
    if (selected.has(idx)) { selected.delete(idx); div.classList.remove("selected"); }
    else { selected.add(idx); div.classList.add("selected"); }
    updateSelBar();
  }
  $("select").addEventListener("click", function () { if (selecting) exitSelect(); else enterSelect(); });
  $("sel-cancel").addEventListener("click", exitSelect);
  $("sel-all").addEventListener("click", function () {
    var els = msgEls();
    if (selected.size >= els.length) {
      selected.clear();
      Array.prototype.forEach.call(els, function (el) { el.classList.remove("selected"); });
    } else {
      Array.prototype.forEach.call(els, function (el) {
        var raw = el.getAttribute("data-idx");
        if (raw != null) { selected.add(+raw); el.classList.add("selected"); }
      });
    }
    updateSelBar();
  });
  $("sel-copy").addEventListener("click", function () {
    if (!selected.size) return;
    var idxs = Array.from(selected).sort(function (a, b) { return a - b; });
    var text = idxs.map(function (i) { return convo[i] ? lineFor(convo[i]) : ""; }).filter(Boolean).join("\\n");
    var btn = $("sel-copy");
    copyToClipboard(text).then(function (ok) {
      btn.textContent = ok ? "✓ Copied" : "✗ Failed";
      setTimeout(function () { btn.textContent = "📋 Copy"; exitSelect(); }, 800);
    });
  });

  // --- Native drag-select → auto message-selection --------------------------------------
  // The zero-friction path (what Telegram desktop does): click-drag to highlight text across
  // bubbles. If the drag stays within ONE bubble it's left as a normal text selection (native
  // copy gives you exactly the substring). The moment it spans TWO OR MORE bubbles we convert
  // it to message selection — enter select mode and tick every touched bubble (blue rings +
  // the action bar) — so it's visually obvious what's selected. From there Cmd/Ctrl+C OR the
  // green Copy button yields the attributed transcript ([ts] Name: text per bubble). Works
  // alongside the explicit "select" button.

  // Does the selection overlap this element's contents? Uses boundary-point comparison
  // (overlap iff selection.start < el.end AND selection.end > el.start), which is portable
  // across browsers — unlike the non-standard Range.intersectsNode / Selection.containsNode.
  function selectionHits(sel, el) {
    var er = document.createRange();
    er.selectNodeContents(el);
    for (var i = 0; i < sel.rangeCount; i++) {
      var r = sel.getRangeAt(i);
      if (r.compareBoundaryPoints(Range.END_TO_START, er) < 0 &&
          r.compareBoundaryPoints(Range.START_TO_END, er) > 0) return true;
    }
    return false;
  }
  function selectedMsgIndices(sel) {
    var els = msgEls(), out = [];
    for (var i = 0; i < els.length; i++) {
      if (selectionHits(sel, els[i])) {
        var raw = els[i].getAttribute("data-idx");
        if (raw != null) out.push(+raw);
      }
    }
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  // On drag-END: if the highlight spans >1 bubble, convert it to message selection. Acting on
  // mouseup (not selectionchange) means we don't disrupt the drag in progress; the text
  // highlight is left intact so Cmd/Ctrl+C below still works too.
  var suppressClickUntil = 0;
  document.addEventListener("mouseup", function () {
    var sel = window.getSelection && window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    var idxs = selectedMsgIndices(sel);
    if (idxs.length < 2) return;
    if (!selecting) enterSelect();
    idxs.forEach(function (i) {
      selected.add(i);
      var el = log.querySelector('.msg[data-idx="' + i + '"]');
      if (el) el.classList.add("selected");
    });
    updateSelBar();
    // A click often fires right after a drag; in select mode that would immediately toggle a
    // bubble back off. Swallow just that one trailing click.
    suppressClickUntil = Date.now() + 80;
  });

  document.addEventListener("copy", function (e) {
    // In select mode with ticked messages, Cmd/Ctrl+C copies the attributed transcript of the
    // selection (covers both the auto-selected drag and the explicit "select" button).
    var ae = document.activeElement;
    var inEditable = ae && (ae.tagName === "TEXTAREA" || ae.tagName === "INPUT" || ae.isContentEditable);
    var idxs;
    if (selecting && selected.size && !inEditable) {
      idxs = Array.from(selected).sort(function (a, b) { return a - b; });
    } else {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return; // nothing highlighted — native copy
      idxs = selectedMsgIndices(sel);
      if (idxs.length < 2) return; // within a single bubble (or outside the log) — leave native copy
    }
    var text = idxs.map(function (i) { return convo[i] ? lineFor(convo[i]) : ""; }).filter(Boolean).join("\\n");
    if (!text || !e.clipboardData || !e.clipboardData.setData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
  });

  // Single delegated #log click handler. In selection mode a tap on a bubble toggles its
  // selection (and we suppress link navigation); the per-code-block Copy button keeps its
  // own behaviour in both modes. The md() function emits that Copy button inside every
  // <pre>; delegating here covers bulk-loaded history and future messages alike.
  log.addEventListener("click", function (e) {
    // Swallow the click that trails a drag-select-to-message-selection (see mouseup above),
    // so the just-selected bubble under the cursor isn't immediately toggled back off.
    if (Date.now() < suppressClickUntil) { suppressClickUntil = 0; return; }
    var onCopyBtn = e.target && e.target.closest && e.target.closest(".copy-btn");
    if (selecting && !onCopyBtn) {
      var msgEl = e.target && e.target.closest && e.target.closest(".msg");
      if (msgEl) { e.preventDefault(); toggleMsg(msgEl); }
      return;
    }
    if (!onCopyBtn) return;
    var pre = onCopyBtn.closest("pre");
    if (!pre) return;
    var code = pre.querySelector("code");
    var text = (code || pre).textContent || "";
    copyToClipboard(text).then(function (ok) {
      onCopyBtn.textContent = ok ? "Copied!" : "Failed";
      onCopyBtn.classList.toggle("copied", ok);
      setTimeout(function () {
        onCopyBtn.textContent = "Copy";
        onCopyBtn.classList.remove("copied");
      }, 1500);
    });
  });

  // True while loadHistory is bulk-loading. The smart-scroll heuristic
  // ("is user at bottom?") doesn't make sense for the initial page load —
  // there's no user there yet to be "at" anywhere. Bypass the heuristic and
  // skip the per-message scroll work; the caller (loadHistory) does a single
  // jumpToBottom() at the end of the batch.
  var bulkLoading = false;
  function addMsg(role, text, attachments, at) {
    var empty = log.querySelector(".empty"); if (empty) empty.remove();
    // Record for the copy/select transcript before any early-return below, so bulk-loaded
    // history is captured too. at is the server timestamp when known (history createdAt or
    // the SSE event id); fall back to now for the user's own just-sent message.
    convo.push({ role: role === "user" ? "user" : "assistant", text: text || "", at: at || new Date().toISOString() });
    var convoIdx = convo.length - 1;
    var wasAtBottom = isAtBottom();
    var div = document.createElement("div");
    // "notice" is a system line (e.g. a compaction marker from /history) — neither bubble.
    div.className = "msg " + (role === "user" ? "user" : role === "notice" ? "notice" : "assistant");
    // Map the bubble back to its convo entry so selection mode can build the transcript.
    div.setAttribute("data-idx", String(convoIdx));
    // Render user messages through md() too. Previously user bubbles were
    // HTML-escaped and wrapped in a single <p>, so typed markdown showed up
    // as literal asterisks/hashes/backticks. md() does its own escaping and
    // gives user-typed code blocks, tables, lists, links, and emphasis the
    // same rendering as assistant replies. (The role only controls the
    // bubble styling — blue vs dark — not the content path.) The text sent
    // to the agent is whatever was typed; this is purely client-side
    // display.
    var html = md(text || "");
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

  // Thinking indicator: a transient assistant bubble shown from the moment a
  // message is sent until the first reply event arrives. It lives in the log
  // DOM only (never pushed into convo, so it stays out of the copy/select
  // transcript) and clearLog's innerHTML reset disposes of it on a conversation
  // switch. A safety timer hides it if no reply ever lands.
  var thinkingTimer = null;
  function showThinking() {
    var empty = log.querySelector(".empty"); if (empty) empty.remove();
    if (!$("thinking")) {
      var div = document.createElement("div");
      div.id = "thinking";
      div.className = "msg assistant thinking";
      div.setAttribute("aria-label", "Artemis is thinking");
      div.innerHTML = "<i></i><i></i><i></i><span class='elapsed'></span>";
      log.appendChild(div);
    }
    jumpToBottom();
    if (thinkingTimer) clearTimeout(thinkingTimer);
    // Give up after 3 min so a dropped/failed reply doesn't spin forever.
    thinkingTimer = setTimeout(hideThinking, 180000);
  }
  function hideThinking() {
    if (thinkingTimer) { clearTimeout(thinkingTimer); thinkingTimer = null; }
    var el = $("thinking"); if (el) el.remove();
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

  // Live streaming: the in-progress assistant bubble built from delta events, plus the last
  // finalized streamed text — used to dedup a reconnect replay of the same persisted reply.
  var streamBubble = null;
  var lastStreamDiv = null; // survives finalize so late chrome (e.g. debug) can attach to it
  var lastStreamed = null;
  function ensureStreamBubble() {
    if (streamBubble) return streamBubble;
    hideThinking();
    var empty = log.querySelector(".empty"); if (empty) empty.remove();
    var wasAtBottom = isAtBottom();
    var div = document.createElement("div");
    div.className = "msg assistant";
    // The reply is an ordered FLOW of blocks (text / thinking / tool rows) appended in the order
    // events arrive, so tools, reasoning, and text interleave chronologically (like Claude) rather
    // than being grouped by type. A footer (turn-meta) carries elapsed time / tokens + debug chip.
    var flow = document.createElement("div");
    var meta = document.createElement("div"); meta.className = "turn-meta";
    var metaText = document.createElement("span");
    meta.appendChild(metaText);
    div.appendChild(flow);
    div.appendChild(meta);
    log.appendChild(div);
    convo.push({ role: "assistant", text: "", at: new Date().toISOString() });
    var idx = convo.length - 1;
    div.setAttribute("data-idx", String(idx));
    // cur = the currently-open text/thinking block; textBlocks = all text blocks (md-rendered at
    // turn_done); fullText = the concatenated reply text (for the copy transcript).
    streamBubble = { div: div, flow: flow, meta: meta, metaText: metaText, toolRows: {}, cur: null, textBlocks: [], fullText: "", idx: idx };
    lastStreamDiv = div;
    if (wasAtBottom) jumpToBottom();
    return streamBubble;
  }
  function finalizeStream() {
    if (!streamBubble) return;
    convo[streamBubble.idx].text = streamBubble.fullText;
    streamBubble = null;
  }
  // A tool call — or a switch between text and thinking — closes the open block so the next delta
  // starts a fresh block below it, preserving chronological order in the flow.
  function closeCur() { if (streamBubble) streamBubble.cur = null; }
  function textBlock() {
    var s = ensureStreamBubble();
    if (s.cur && s.cur.type === "text") return s.cur;
    var el = document.createElement("div"); el.className = "reply-block";
    s.flow.appendChild(el);
    s.cur = { type: "text", el: el, text: "" };
    s.textBlocks.push(s.cur);
    return s.cur;
  }
  // Shared DOM builders for the activity chrome — used both by live streaming and by history
  // reconstruction (so a reloaded conversation rebuilds the same tool rows + reasoning).
  function makeReasoning(text, collapsed) {
    // A collapsible "💭 Thinking" disclosure — distinct from the reply (muted, italic).
    var el = document.createElement("div"); el.className = "reasoning" + (collapsed ? " collapsed" : "");
    var head = document.createElement("div"); head.className = "rhead";
    var chev = document.createElement("span"); chev.className = "chev"; chev.textContent = collapsed ? "▸" : "▾";
    var lbl = document.createElement("span"); lbl.textContent = "💭 Thinking";
    head.appendChild(chev); head.appendChild(lbl);
    var body = document.createElement("div"); body.className = "rbody"; body.textContent = text || "";
    head.addEventListener("click", function () {
      el.classList.toggle("collapsed");
      chev.textContent = el.classList.contains("collapsed") ? "▸" : "▾";
    });
    el.appendChild(head); el.appendChild(body);
    return { el: el, body: body, chev: chev };
  }
  function makeToolRow(name, input, status) {
    // status: "running" | "ok" | "err". Collapsible header (Ran <name> + arg summary + state)
    // expanding to the full input.
    var row = document.createElement("div");
    row.className = "tool-call" + (status === "running" ? " running" : status === "err" ? " err" : " ok");
    var head = document.createElement("div"); head.className = "head";
    var chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▸";
    var label = document.createElement("span"); label.className = "label";
    label.appendChild(document.createTextNode("Ran "));
    var nm = document.createElement("span"); nm.className = "name"; nm.textContent = name || "tool";
    label.appendChild(nm);
    var sum = document.createElement("span"); sum.className = "sum"; sum.textContent = toolSummary(input);
    var state = document.createElement("span"); state.className = "state";
    state.textContent = status === "running" ? "…" : status === "err" ? "✗" : "✓";
    head.appendChild(chev); head.appendChild(label); head.appendChild(sum); head.appendChild(state);
    var detail = document.createElement("div"); detail.className = "detail";
    var pre = document.createElement("pre"); pre.textContent = toolDetail(input); detail.appendChild(pre);
    head.addEventListener("click", function () { row.classList.toggle("open"); chev.textContent = row.classList.contains("open") ? "▾" : "▸"; });
    row.appendChild(head); row.appendChild(detail);
    return { row: row, state: state };
  }
  function thinkBlock() {
    var s = ensureStreamBubble();
    if (s.cur && s.cur.type === "thinking") return s.cur;
    var r = makeReasoning("", false); // expanded while streaming; auto-collapsed at turn_done
    s.flow.appendChild(r.el);
    s.cur = { type: "thinking", el: r.el, body: r.body, chev: r.chev, text: "" };
    return s.cur;
  }
  // While a reply streams we show the RAW text as it types and render full markdown only once, at
  // turn_done. This avoids re-parsing partial markdown every token (the "wobble") and the
  // mid-stream table flicker. Prose stays proportional; only code fences and table rows are shown
  // monospace (so they stay aligned and read as code). Re-segmenting is cheap (line classification
  // + a few text blocks — no inline markdown parsing), throttled to ~10/sec.
  var FENCE = String.fromCharCode(96, 96, 96); // three backticks, built without a literal backtick (which would close this template literal)
  function segmentRaw(text) {
    var lines = text.split("\\n");
    var segs = [], cur = [], curMono = null, inFence = false;
    function flush() { if (cur.length && curMono !== null) segs.push({ mono: curMono, text: cur.join("\\n") }); cur = []; }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/^\\s+/, "");
      var isFence = t.indexOf(FENCE) === 0; // code-fence line
      var mono = isFence || inFence || t.charAt(0) === "|"; // fence body, or a table row
      if (curMono === null) curMono = mono;
      if (mono !== curMono) { flush(); curMono = mono; }
      cur.push(lines[i]);
      if (isFence) inFence = !inFence;
    }
    flush();
    return segs;
  }
  function renderRaw(body, text) {
    body.textContent = "";
    var segs = segmentRaw(text);
    for (var i = 0; i < segs.length; i++) {
      var el = document.createElement("div");
      el.className = segs[i].mono ? "stream-mono" : "stream-prose";
      el.textContent = segs[i].text;
      body.appendChild(el);
    }
  }
  var renderTimer = null;
  function scheduleRawRender() {
    if (renderTimer || !streamBubble || !streamBubble.cur || streamBubble.cur.type !== "text") return;
    renderTimer = setTimeout(function () {
      renderTimer = null;
      if (!streamBubble || !streamBubble.cur || streamBubble.cur.type !== "text") return;
      var atBottom = isAtBottom();
      renderRaw(streamBubble.cur.el, streamBubble.cur.text);
      if (atBottom) jumpToBottom();
    }, 90);
  }

  // Claude-style turn timer: a live "Xs" from send until the reply completes, then frozen on the
  // reply's footer alongside the token count (when the provider reported usage). Purely
  // client-side timing; tokens come from the turn_done event.
  var turnStart = 0, turnTimer = null;
  function fmtElapsed(ms) { var s = ms / 1000; return (s < 10 ? s.toFixed(1) : Math.round(s)) + "s"; }
  function fmtTokens(u) {
    function k(n) { n = n || 0; return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + "k" : String(n); }
    return "↑" + k(u.inputTokens) + " ↓" + k(u.outputTokens);
  }
  function tickTurnTimer() {
    var txt = fmtElapsed(Date.now() - turnStart);
    if (streamBubble && streamBubble.metaText) { streamBubble.metaText.textContent = txt; return; }
    var th = $("thinking"); if (th) { var e = th.querySelector(".elapsed"); if (e) e.textContent = txt; }
  }
  function startTurnTimer() {
    turnStart = Date.now();
    if (turnTimer) clearInterval(turnTimer);
    turnTimer = setInterval(tickTurnTimer, 250);
    tickTurnTimer();
  }
  function stopTurnTimer() { if (turnTimer) { clearInterval(turnTimer); turnTimer = null; } }

  // Tool-call display helpers: a one-line summary of the primary argument (collapsed), and the
  // full pretty-printed input (expanded).
  function toolSummary(input) {
    if (!input || typeof input !== "object") return "";
    var keys = ["url", "path", "file_path", "command", "cmd", "query", "pattern", "name", "content"];
    for (var i = 0; i < keys.length; i++) { if (typeof input[keys[i]] === "string") return input[keys[i]]; }
    for (var key in input) { if (typeof input[key] === "string") return input[key]; }
    try { return JSON.stringify(input); } catch (e) { return ""; }
  }
  function toolDetail(input) {
    try { return JSON.stringify(input, null, 2); } catch (e) { return String(input); }
  }

  function connect() {
    if (es) es.close();
    var u = "/events?externalUserId=" + encodeURIComponent(uid) +
            (convId ? "&conversationId=" + encodeURIComponent(convId) : "") +
            (token ? "&token=" + encodeURIComponent(token) : "");
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
      // Defensive: the stream is already per-conversation, but if a reply for a different
      // conversation ever reaches us (e.g. via the legacy bare-key broadcast during a deploy),
      // don't render it into the conversation the user is currently looking at.
      if (d.conversationId && convId && d.conversationId !== convId) return;
      // A streamed turn finalizes via its own turn_done. If a buffered/replayed message for the
      // SAME text arrives (e.g. reconnect replay of the now-persisted reply), don't render it
      // twice. Any still-open stream bubble (e.g. a pending question interrupted streaming) is
      // finalized first so it isn't left dangling.
      finalizeStream();
      stopTurnTimer();
      if (lastStreamed && d.text && d.text === lastStreamed.text && Date.now() - lastStreamed.at < 15000) {
        lastStreamed = null;
        hideThinking();
        return;
      }
      // A reply for this conversation has landed — drop the thinking indicator.
      hideThinking();
      // ev.lastEventId carries the event's id line — the server's ISO send time (or the
      // persisted createdAt for replayed messages) — so the transcript timestamp is accurate.
      addMsg("assistant", d.text || "", d.attachments || [], ev.lastEventId);
      maybeNotify(d.text || "");
      // A reply may have triggered a server-side model-generated title for this conversation
      // (and bumped its recency); refresh the sidebar so the new label/order shows without a
      // manual reload. Cheap JSON; doesn't touch the open chat log.
      loadConversations();
    });

    // Live streaming events (token-by-token). These render into a single in-progress assistant
    // bubble; turn_done finalizes it. They carry no id line, so they never disturb the
    // Last-Event-ID replay contract — the final reply is persisted and reloaded from history.
    es.addEventListener("delta", function (ev) {
      markActivity();
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.conversationId && convId && d.conversationId !== convId) return;
      var b = textBlock();
      b.text += d.text || "";
      streamBubble.fullText += d.text || "";
      // Raw typing view (prose proportional, code/tables monospace); markdown renders at turn_done.
      scheduleRawRender();
    });
    es.addEventListener("thinking", function (ev) {
      markActivity();
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.conversationId && convId && d.conversationId !== convId) return;
      var wasAtBottom = isAtBottom();
      var b = thinkBlock();
      b.text += d.text || "";
      b.body.textContent = b.text;
      if (wasAtBottom) jumpToBottom();
    });
    es.addEventListener("tool", function (ev) {
      markActivity();
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.conversationId && convId && d.conversationId !== convId) return;
      var s = ensureStreamBubble();
      closeCur(); // a tool call ends the current text/thinking block; it sits inline in the flow
      var t = makeToolRow(d.name, d.input, "running"); // tool_done resolves it to ok/error
      s.flow.appendChild(t.row);
      s.toolRows[d.id] = { state: t.state, row: t.row };
      if (isAtBottom()) jumpToBottom();
    });
    es.addEventListener("tool_done", function (ev) {
      markActivity();
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (!streamBubble || !streamBubble.toolRows[d.id]) return;
      var t = streamBubble.toolRows[d.id];
      t.row.classList.remove("running");
      t.row.classList.add(d.isError ? "err" : "ok");
      t.state.textContent = d.isError ? "✗" : "✓";
    });
    es.addEventListener("debug", function (ev) {
      markActivity();
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.conversationId && convId && d.conversationId !== convId) return;
      // The debug pointer arrives after turn_done; attach it to the just-finished reply's footer.
      var div = streamBubble ? streamBubble.div : lastStreamDiv;
      if (!div) return;
      var meta = div.querySelector(".turn-meta");
      if (!meta) return;
      var chip = document.createElement("span");
      chip.className = "chip debug";
      chip.title = (d.path || "") + " (click to copy)";
      var dot = document.createElement("b"); dot.className = "dot";
      var lbl = document.createElement("span"); lbl.textContent = "debug log";
      chip.appendChild(dot); chip.appendChild(lbl);
      chip.addEventListener("click", function () { copyToClipboard(d.path || ""); });
      meta.appendChild(chip);
    });
    es.addEventListener("turn_done", function (ev) {
      markActivity();
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.conversationId && convId && d.conversationId !== convId) return;
      if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
      stopTurnTimer();
      if (!streamBubble) return;
      // Render each streamed text block as markdown now the turn is complete (each block is a
      // self-contained run of reply text between tool calls / reasoning).
      for (var i = 0; i < streamBubble.textBlocks.length; i++) {
        var tb = streamBubble.textBlocks[i];
        tb.el.className = "";
        tb.el.innerHTML = md(tb.text);
      }
      // Collapse reasoning blocks now the turn is done — they stay one click away.
      var rs = streamBubble.flow.querySelectorAll(".reasoning");
      for (var r = 0; r < rs.length; r++) {
        rs[r].classList.add("collapsed");
        var cv = rs[r].querySelector(".chev"); if (cv) cv.textContent = "▸";
      }
      // Freeze the timer on the reply footer, with the token count when usage was reported.
      streamBubble.metaText.textContent = fmtElapsed(Date.now() - turnStart) + (d.usage ? " · " + fmtTokens(d.usage) : "");
      lastStreamed = { text: streamBubble.fullText, at: Date.now() };
      var done = streamBubble.fullText;
      finalizeStream();
      maybeNotify(done);
      loadConversations();
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

  // Rebuild an assistant bubble from persisted history blocks (text / thinking / tool), so a
  // reloaded conversation (or one opened on another device) shows the same inline chrome as the
  // live stream. Reasoning is collapsed and tool rows show their resolved ✓/✗ state.
  function addHistoryAssistant(m) {
    var empty = log.querySelector(".empty"); if (empty) empty.remove();
    var div = document.createElement("div"); div.className = "msg assistant";
    var flow = document.createElement("div");
    (m.blocks || []).forEach(function (b) {
      if (b.t === "text") {
        var tb = document.createElement("div"); tb.innerHTML = md(b.text || ""); flow.appendChild(tb);
      } else if (b.t === "thinking") {
        flow.appendChild(makeReasoning(b.text || "", true).el);
      } else if (b.t === "tool") {
        flow.appendChild(makeToolRow(b.name, b.input, b.isError ? "err" : "ok").row);
      }
    });
    div.appendChild(flow);
    log.appendChild(div);
    // Record for the copy/select transcript (the server text field is the flattened reply text).
    convo.push({ role: "assistant", text: m.text || "", at: m.at || new Date().toISOString() });
    div.setAttribute("data-idx", String(convo.length - 1));
    return div;
  }

  function loadHistory() {
    var u = "/history?externalUserId=" + encodeURIComponent(uid) +
            (convId ? "&conversationId=" + encodeURIComponent(convId) : "");
    fetch(u, { headers: authHeaders() })
      .then(function (r) { if (on401(r)) return { messages: [] }; return r.ok ? r.json() : { messages: [] }; })
      .then(function (j) {
        // Bulk-load: bypass the smart-scroll per-message work and the "↓ N new
        // messages" pill (these are HISTORY, not new) — then snap to the
        // bottom once at the end so the user sees the most recent reply.
        bulkLoading = true;
        try {
          (j.messages || []).forEach(function (m) {
            // Assistant messages carry structured blocks (text / thinking / tool) so we rebuild
            // the inline chrome; everything else (user, notices) is plain text.
            if (m.role === "assistant" && m.blocks && m.blocks.length) addHistoryAssistant(m);
            else addMsg(m.role, m.text || "", m.attachments || [], m.at);
          });
        } finally { bulkLoading = false; }
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
    if (convId) body.conversationId = convId;
    if (text) body.text = text;
    if (atts.length) body.attachments = atts;
    // Optimistically name a still-unnamed conversation from its first message, mirroring the
    // server's auto-title, so the sidebar updates instantly instead of after a round-trip.
    if (text) maybeTitleCurrent(text);
    addMsg("user", text, atts, new Date().toISOString());
    $("text").value = ""; pending = []; renderChips(); autosize();
    cmdMatches = []; renderCmdMenu();
    showThinking();
    startTurnTimer();
    fetch("/messages", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      .then(function (r) { if (on401(r)) { hideThinking(); stopTurnTimer(); return; } if (!r.ok) { hideThinking(); stopTurnTimer(); statusEl.textContent = "send failed (" + r.status + ")"; } })
      .catch(function () { hideThinking(); stopTurnTimer(); statusEl.textContent = "send failed"; });
  }

  function autosize() { var t = $("text"); t.style.height = "auto"; t.style.height = Math.min(t.scrollHeight, 180) + "px"; }
  $("text").addEventListener("input", autosize);
  $("send").addEventListener("click", send);

  // --- Slash-command autocomplete -----------------------------------------------------------
  // GET /commands lists the slash-commands the assistant accepts (name/description/aliases).
  // While the draft is a lone "/word", a menu of prefix-matches floats above the input.
  var commands = [];
  var cmdMatches = [];
  var cmdIndex = 0;
  var cmdMenu = $("cmd-menu");
  function loadCommands() {
    fetch("/commands", { headers: authHeaders() })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { if (j && j.commands) commands = j.commands; })
      .catch(function () {});
  }
  // The command prefix currently typed, or null when the draft isn't a lone "/word".
  function cmdPrefix() {
    var m = $("text").value.match(/^\\/([A-Za-z0-9_-]*)$/);
    return m ? m[1].toLowerCase() : null;
  }
  function renderCmdMenu() {
    cmdMenu.innerHTML = "";
    cmdMatches.forEach(function (c, i) {
      var it = document.createElement("div");
      it.className = "item" + (i === cmdIndex ? " active" : "");
      it.setAttribute("data-cmd", c.name);
      var n = document.createElement("span"); n.className = "name"; n.textContent = "/" + c.name;
      it.appendChild(n);
      if (c.description) {
        var d = document.createElement("span"); d.className = "desc"; d.textContent = c.description;
        it.appendChild(d);
      }
      cmdMenu.appendChild(it);
    });
    cmdMenu.classList.toggle("on", cmdMatches.length > 0);
  }
  function updateCmdMenu() {
    var p = cmdPrefix();
    cmdMatches = p === null ? [] : commands.filter(function (c) {
      return c.name.toLowerCase().indexOf(p) === 0 ||
             (c.aliases || []).some(function (a) { return a.toLowerCase().indexOf(p) === 0; });
    });
    cmdIndex = 0;
    renderCmdMenu();
  }
  function pickCmd(name) {
    $("text").value = "/" + name + " ";
    cmdMatches = []; renderCmdMenu();
    $("text").focus(); autosize();
  }
  // mousedown (not click) so we can preventDefault and keep the textarea focused.
  cmdMenu.addEventListener("mousedown", function (e) {
    var it = e.target && e.target.closest && e.target.closest(".item");
    if (it) { e.preventDefault(); pickCmd(it.getAttribute("data-cmd")); }
  });
  $("text").addEventListener("input", updateCmdMenu);
  $("text").addEventListener("blur", function () { cmdMatches = []; renderCmdMenu(); });
  $("text").addEventListener("keydown", function (e) {
    if (cmdMatches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); cmdIndex = (cmdIndex + 1) % cmdMatches.length; renderCmdMenu(); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); cmdIndex = (cmdIndex - 1 + cmdMatches.length) % cmdMatches.length; renderCmdMenu(); return; }
      if (e.key === "Escape") { cmdMatches = []; renderCmdMenu(); return; }
      if (e.key === "Tab") { e.preventDefault(); pickCmd(cmdMatches[cmdIndex].name); return; }
      // Enter completes the highlighted command — unless it's already fully typed,
      // in which case it falls through and sends.
      if (e.key === "Enter" && !e.shiftKey && cmdMatches[cmdIndex].name !== cmdPrefix()) {
        e.preventDefault(); pickCmd(cmdMatches[cmdIndex].name); return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
  });

  $("gear").addEventListener("click", function () { $("settings").classList.toggle("on"); $("uid").textContent = "id: " + uid; $("token").value = token; });
  $("save").addEventListener("click", function () { token = $("token").value.trim(); LS.setItem("dae_token", token); $("settings").classList.remove("on"); connect(); });

  // --- Conversations (separate sessions) --------------------------------------------------
  // The sidebar lists the user's web conversations with this assistant. The default/"Main"
  // session (defaultConvId) is the cross-channel thread (Telegram etc.) — it is HIDDEN here:
  // web chats are isolated, fresh-context conversations, every one of them deletable. On
  // load, the most recent web conversation is opened (one is created if none exist yet).
  // Switching one swaps the whole view: clear the log, load that conversation's history,
  // and reconnect the SSE stream to it.

  // The display label for a conversation: the auto/explicit title, falling back to
  // "New chat" until the first message names it.
  function convLabel(c) { return c.title || "New chat"; }

  function renderConversations() {
    var listEl = $("convo-list");
    listEl.innerHTML = "";
    conversations.forEach(function (c) {
      var row = document.createElement("div");
      row.className = "convo" + (c.id === convId ? " active" : "");
      row.setAttribute("data-id", c.id);
      var t = document.createElement("span");
      t.className = "title";
      t.textContent = convLabel(c);
      row.appendChild(t);
      var del = document.createElement("button");
      del.className = "del"; del.type = "button"; del.title = "Delete conversation";
      del.textContent = "✕";
      del.setAttribute("data-del", c.id);
      row.appendChild(del);
      listEl.appendChild(row);
    });
  }

  // Reset the chat view to empty (used when switching/deleting conversations).
  function clearLog() {
    convo = [];
    if (selecting) exitSelect();
    log.innerHTML = '<div class="empty">No messages yet. Say hello.</div>';
    newSinceScrolled = 0;
    pill.classList.remove("on");
    // Drop any in-progress streamed bubble state so it can't bleed across conversations.
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    stopTurnTimer();
    streamBubble = null;
    lastStreamDiv = null;
    lastStreamed = null;
  }

  function openSidebar() { document.body.classList.add("sb-open"); }
  function closeSidebar() { document.body.classList.remove("sb-open"); }

  function loadConversations(cb) {
    fetch("/conversations?externalUserId=" + encodeURIComponent(uid), { headers: authHeaders() })
      .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) { if (cb) cb(); return; }
        defaultConvId = j.defaultId || "";
        // Hide the default/"Main" session — it's the cross-channel (Telegram etc.) thread,
        // not a web conversation. Web only ever shows (and writes to) its own conversations.
        conversations = (j.conversations || []).filter(function (c) { return c.id !== defaultConvId; });
        // Reopen the remembered conversation if it still exists; otherwise fall back to the
        // most recent web conversation, creating the first one if there are none yet.
        var exists = conversations.some(function (c) { return c.id === convId; });
        if (!convId || !exists) {
          if (!conversations.length) { createFirstConversation(cb); return; }
          convId = conversations[0].id; LS.setItem("dae_conv", convId);
        }
        renderConversations();
        if (cb) cb();
      })
      .catch(function (err) { console.error("loadConversations failed", err); if (cb) cb(); });
  }

  // Bootstrap path: no web conversations exist yet (fresh browser, or the last one was just
  // deleted) — create one and select it. The server's reuse guardrail makes this idempotent.
  function createFirstConversation(cb) {
    fetch("/conversations?externalUserId=" + encodeURIComponent(uid), { method: "POST", headers: authHeaders(), body: "{}" })
      .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
      .then(function (c) {
        if (c && c.id) {
          if (!conversations.some(function (x) { return x.id === c.id; })) conversations.unshift(c);
          convId = c.id; LS.setItem("dae_conv", convId);
        }
        renderConversations();
        if (cb) cb();
      })
      .catch(function () { renderConversations(); if (cb) cb(); });
  }

  function selectConversation(id) {
    if (!id) return;
    if (id === convId) { closeSidebar(); return; }
    convId = id; LS.setItem("dae_conv", convId);
    renderConversations();
    clearLog();
    loadHistory();
    connect();
    closeSidebar();
  }

  // Guardrail against piling up blank chats from repeated clicks:
  //   1. If an unused chat already exists locally (non-default, no title yet), just open it.
  //   2. Otherwise create one — but block concurrent creates with an in-flight flag, and if the
  //      server hands back an existing empty chat (its own guardrail), don't duplicate it.
  var creatingConvo = false;
  function newConversation() {
    var unused = conversations.filter(function (c) { return !c.title; })[0];
    if (unused) { selectConversation(unused.id); return; }
    if (creatingConvo) return;
    creatingConvo = true;
    // externalUserId goes on the query string (the server reads the user from the cookie in
    // login mode, but from this param in token/open mode — same as GET/DELETE /conversations).
    fetch("/conversations?externalUserId=" + encodeURIComponent(uid), { method: "POST", headers: authHeaders(), body: "{}" })
      .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
      .then(function (c) {
        creatingConvo = false;
        if (!c || !c.id) { statusEl.textContent = "couldn't start a new chat"; return; }
        var known = conversations.some(function (x) { return x.id === c.id; });
        if (!known) conversations.unshift(c);
        selectConversation(c.id);
      })
      .catch(function () { creatingConvo = false; statusEl.textContent = "couldn't start a new chat"; });
  }

  function deleteConversation(id) {
    var match = conversations.filter(function (x) { return x.id === id; })[0];
    var label = match ? convLabel(match) : "this conversation";
    if (!window.confirm('Delete "' + label + '"? This cannot be undone.')) return;
    fetch("/conversations?externalUserId=" + encodeURIComponent(uid) + "&id=" + encodeURIComponent(id),
          { method: "DELETE", headers: authHeaders() })
      .then(function (r) {
        if (on401(r)) return;
        if (!r.ok) { statusEl.textContent = "delete failed (" + r.status + ")"; return; }
        conversations = conversations.filter(function (x) { return x.id !== id; });
        // If we deleted the conversation we were viewing, open the next most recent web
        // conversation — or bootstrap a fresh one when that was the last.
        if (id === convId) {
          convId = "";
          clearLog();
          if (conversations.length) {
            convId = conversations[0].id; LS.setItem("dae_conv", convId);
            loadHistory(); connect();
          } else {
            createFirstConversation(function () { loadHistory(); connect(); });
          }
        }
        renderConversations();
      })
      .catch(function () { statusEl.textContent = "delete failed"; });
  }

  // Optimistic local title for an unnamed conversation (mirrors the server's auto-title from
  // the first user message) so the sidebar label updates the instant you hit send.
  function maybeTitleCurrent(text) {
    var c = conversations.filter(function (x) { return x.id === convId; })[0];
    if (!c || c.title) return;
    var first = text.split("\\n").map(function (l) { return l.trim(); }).filter(Boolean)[0] || "";
    var t = first.replace(/\\s+/g, " ").trim();
    if (!t) return;
    c.title = t.length > 50 ? t.slice(0, 49) + "…" : t;
    renderConversations();
  }

  $("sb-toggle").addEventListener("click", function () { document.body.classList.toggle("sb-open"); });
  $("sb-scrim").addEventListener("click", closeSidebar);
  $("new-convo").addEventListener("click", newConversation);
  $("convo-list").addEventListener("click", function (e) {
    var del = e.target && e.target.closest && e.target.closest(".del");
    if (del) { e.stopPropagation(); deleteConversation(del.getAttribute("data-del")); return; }
    var row = e.target && e.target.closest && e.target.closest(".convo");
    if (row) selectConversation(row.getAttribute("data-id"));
  });

  // Load the conversation list first, then open the active one's history + live stream.
  loadConversations(function () { loadHistory(); connect(); });
  loadCommands();
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
