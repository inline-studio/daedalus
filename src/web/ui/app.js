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

  // --- Desktop shell (Electron) integration -----------------------------------------------
  // The desktop app's preload exposes window.daedalusDesktop {platform, setBadge}. When
  // present: count unread replies onto the dock badge while the window is hidden (cleared
  // on refocus, both here and by the shell), and pad the sidebar brand clear of the macOS
  // traffic lights (the shell uses a hidden title bar).
  var DESKTOP = typeof window.daedalusDesktop === "object" && window.daedalusDesktop !== null;
  var unread = 0;
  if (DESKTOP && window.daedalusDesktop.platform === "darwin") {
    document.body.classList.add("desktop-mac");
  }
  function noteUnread() {
    if (!DESKTOP) return;
    unread++;
    try { window.daedalusDesktop.setBadge(unread); } catch (e) {}
  }
  document.addEventListener("visibilitychange", function () {
    if (!document.hidden && DESKTOP && unread) {
      unread = 0;
      try { window.daedalusDesktop.setBadge(0); } catch (e) {}
    }
  });

  // Browser notification when a reply lands and the tab isn't focused (opt-in; see the 🔔 button).
  function maybeNotify(text) {
    // Dock badge is independent of the notification opt-in — it's unobtrusive.
    if (document.hidden) noteUnread();
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
    var on = notifyOn && Notification.permission === "granted";
    b.classList.toggle("on", on);
    b.title = on
      ? "Reply notifications are ON (click to turn off)"
      : "Notify me when a reply lands and this tab isn't focused";
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

  // Markdown → sanitized HTML. marked does the GFM parse (headings, lists,
  // tables, fenced code with a language-* class), DOMPurify strips anything
  // unsafe before it reaches the DOM. Both are loaded as /vendor/*.js includes
  // ahead of this script. We then add a Copy button to each code block and
  // force links open safely in a new tab.
  function md(src) {
    if (src == null) src = "";
    var raw;
    try {
      raw = window.marked.parse(String(src), { gfm: true, breaks: true });
    } catch (_e) {
      raw = "<p>" + esc(String(src)) + "</p>";
    }
    var box = document.createElement("div");
    box.innerHTML = window.DOMPurify.sanitize(raw);
    // Copy button per code block, added AFTER sanitize so DOMPurify can't drop
    // it. The click handler reads the <code> textContent, so the button label
    // and the language class never end up in the copied snippet.
    var pres = box.querySelectorAll("pre");
    for (var i = 0; i < pres.length; i++) {
      if (pres[i].querySelector(".copy-btn")) continue;
      var btn = document.createElement("button");
      btn.className = "copy-btn";
      btn.type = "button";
      btn.textContent = "Copy";
      pres[i].insertBefore(btn, pres[i].firstChild);
    }
    var links = box.querySelectorAll("a[href]");
    for (var j = 0; j < links.length; j++) {
      links[j].setAttribute("target", "_blank");
      links[j].setAttribute("rel", "noopener noreferrer");
    }
    return box.innerHTML;
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
    var text = idxs.map(function (i) { return convo[i] ? lineFor(convo[i]) : ""; }).filter(Boolean).join("\n");
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
    var text = idxs.map(function (i) { return convo[i] ? lineFor(convo[i]) : ""; }).filter(Boolean).join("\n");
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
    streamBubble = { div: div, flow: flow, meta: meta, metaText: metaText, toolRows: {}, subPanels: {}, cur: null, textBlocks: [], fullText: "", idx: idx };
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
  function makeSubagentPanel(path, prompt) {
    // One spawn_subagent call's live activity: a collapsible panel (expanded while running)
    // holding the delegated prompt and the subagent's tool rows as they happen.
    var el = document.createElement("div"); el.className = "subagent running";
    var head = document.createElement("div"); head.className = "shead";
    var chev = document.createElement("span"); chev.className = "chev"; chev.textContent = "▾";
    var lbl = document.createElement("span"); lbl.className = "slabel";
    lbl.textContent = "⚙ " + (path && path.length ? path[0] : "subagent");
    var state = document.createElement("span"); state.className = "state"; state.textContent = "working…";
    head.appendChild(chev); head.appendChild(lbl); head.appendChild(state);
    var body = document.createElement("div"); body.className = "sbody";
    if (prompt) {
      var p = document.createElement("div"); p.className = "sprompt"; p.title = prompt; p.textContent = prompt;
      body.appendChild(p);
    }
    head.addEventListener("click", function () {
      el.classList.toggle("collapsed");
      chev.textContent = el.classList.contains("collapsed") ? "▸" : "▾";
    });
    el.appendChild(head); el.appendChild(body);
    return {
      el: el, body: body, tools: {},
      finish: function (status) {
        el.classList.remove("running");
        el.classList.add(status === "error" ? "err" : "done");
        el.classList.add("collapsed");
        chev.textContent = "▸";
        state.textContent = status === "complete" ? "done" : status === "pending_question" ? "needs input" : "failed";
      },
    };
  }
  // While a reply streams we show the RAW text as it types and render full markdown only once, at
  // turn_done. This avoids re-parsing partial markdown every token (the "wobble") and the
  // mid-stream table flicker. Prose stays proportional; only code fences and table rows are shown
  // monospace (so they stay aligned and read as code). Re-segmenting is cheap (line classification
  // + a few text blocks — no inline markdown parsing), throttled to ~10/sec.
  var FENCE = String.fromCharCode(96, 96, 96); // three backticks, built without a literal backtick (which would close this template literal)
  function segmentRaw(text) {
    var lines = text.split("\n");
    var segs = [], cur = [], curMono = null, inFence = false;
    function flush() { if (cur.length && curMono !== null) segs.push({ mono: curMono, text: cur.join("\n") }); cur = []; }
    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].replace(/^\s+/, "");
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

  // --- Per-session view options: show/hide thinking, stream vs whole-reply. Stored per
  // conversation id so the DnD session can run clean while work sessions stay verbose.
  function viewOpts() {
    var all;
    try { all = JSON.parse(LS.getItem("dae_view") || "{}"); } catch (e) { all = {}; }
    var v = (convId && all[convId]) || {};
    return { thinking: v.thinking !== false, stream: v.stream !== false };
  }
  function setViewOpt(key, val) {
    var all;
    try { all = JSON.parse(LS.getItem("dae_view") || "{}"); } catch (e) { all = {}; }
    if (!convId) return;
    var v = all[convId] || {};
    v[key] = val;
    all[convId] = v;
    LS.setItem("dae_view", JSON.stringify(all));
  }
  var viewMenu = $("view-menu");
  function closeViewMenu() { viewMenu.style.display = "none"; }
  $("view-opts").addEventListener("click", function (e) {
    e.stopPropagation();
    if (viewMenu.style.display !== "none") { closeViewMenu(); return; }
    var v = viewOpts();
    $("view-thinking").checked = v.thinking;
    $("view-stream").checked = v.stream;
    viewMenu.style.display = "block";
  });
  document.addEventListener("click", function (e) {
    if (viewMenu.style.display !== "none" && !(e.target.closest && e.target.closest("#view-wrap"))) closeViewMenu();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && viewMenu.style.display !== "none") closeViewMenu();
  });
  $("view-thinking").addEventListener("change", function () { setViewOpt("thinking", this.checked); });
  $("view-stream").addEventListener("change", function () { setViewOpt("stream", this.checked); });

  // With streaming off, reply tokens accumulate here invisibly and land as one complete
  // message at turn_done.
  var suppressedText = "";

  function connect() {
    if (es) es.close();
    var u = "/events?externalUserId=" + encodeURIComponent(uid) +
            (convId ? "&conversationId=" + encodeURIComponent(convId) : "") +
            (token ? "&token=" + encodeURIComponent(token) : "");
    es = new EventSource(u);
    es.onopen = function () { statusEl.textContent = "connected"; setGateway("ok"); markActivity(); };
    es.onerror = function () { statusEl.textContent = "reconnecting…"; setGateway("warn"); };
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
      setTurnActive(false);
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
      // A turn is visibly in flight (covers reloads mid-turn and turns started elsewhere).
      if (!turnActive) setTurnActive(true);
      if (!viewOpts().stream) { suppressedText += d.text || ""; return; } // whole-reply mode
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
      if (!turnActive) setTurnActive(true);
      var v = viewOpts();
      if (!v.thinking || !v.stream) return; // hidden for this session
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
      if (!turnActive) setTurnActive(true);
      if (!viewOpts().stream) return; // whole-reply mode: no live chrome
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
    // Subagent activity: every event of one spawn_subagent call shares a spawnId and renders
    // into one collapsible panel inline in the flow. Nested spawns arrive with the same spawnId
    // and a longer path — their tool rows land in the same panel, name-prefixed by the chain.
    es.addEventListener("subagent", function (ev) {
      markActivity();
      var d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.conversationId && convId && d.conversationId !== convId) return;
      if (!turnActive) setTurnActive(true);
      if (!viewOpts().stream) return; // whole-reply mode: no live chrome
      var s = ensureStreamBubble();
      var panel = s.subPanels[d.spawnId];
      if (d.kind === "start") {
        if (!panel) {
          closeCur(); // the panel sits inline in the flow, like a tool row
          panel = makeSubagentPanel(d.path, d.prompt);
          s.flow.appendChild(panel.el);
          s.subPanels[d.spawnId] = panel;
        } else if (d.path && d.path.length > 1) {
          // A nested spawn inside this panel — note it as a line rather than a sub-panel.
          var n = document.createElement("div"); n.className = "sprompt";
          n.textContent = "⚙ " + d.path.join(" › ") + (d.prompt ? " — " + d.prompt : "");
          n.title = d.prompt || "";
          panel.body.appendChild(n);
        }
        if (isAtBottom()) jumpToBottom();
        return;
      }
      if (!panel) return;
      if (d.kind === "tool") {
        var prefix = d.path && d.path.length > 1 ? d.path.slice(1).join(" › ") + " › " : "";
        var t = makeToolRow(prefix + (d.name || "tool"), d.input, "running");
        panel.body.appendChild(t.row);
        panel.tools[d.id] = t;
        if (isAtBottom()) jumpToBottom();
      } else if (d.kind === "tool_done") {
        var tr = panel.tools[d.id];
        if (tr) {
          tr.row.classList.remove("running");
          tr.row.classList.add(d.isError ? "err" : "ok");
          tr.state.textContent = d.isError ? "✗" : "✓";
        }
      } else if (d.kind === "end") {
        panel.finish(d.status);
      }
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
      setTurnActive(false);
      // Whole-reply mode: the tokens were held back — deliver them as one complete message.
      if (suppressedText) {
        var whole = suppressedText;
        suppressedText = "";
        hideThinking();
        addMsg("assistant", whole, [], ev.lastEventId);
        if (d.context && d.context.inputTokens) updateContext(d.context);
        lastStreamed = { text: whole, at: Date.now() }; // dedup vs a replayed persisted copy
        maybeNotify(whole);
        loadConversations();
        return;
      }
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
      // Status-bar context readout: how full the model's window was on this turn.
      if (d.context && d.context.inputTokens) updateContext(d.context);
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
    var showThinking = viewOpts().thinking;
    (m.blocks || []).forEach(function (b) {
      if (b.t === "text") {
        var tb = document.createElement("div"); tb.innerHTML = md(b.text || ""); flow.appendChild(tb);
      } else if (b.t === "thinking") {
        if (showThinking) flow.appendChild(makeReasoning(b.text || "", true).el);
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
        // Nothing in this conversation (and nothing streamed in while loading) → splash.
        if (!(j.messages || []).length && !log.children.length) log.innerHTML = splashHtml();
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

  function addFilesFromInput(e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    Promise.all(files.map(fileToAttachment)).then(function (atts) { pending = pending.concat(atts); renderChips(); });
    e.target.value = "";
  }
  $("file").addEventListener("change", addFilesFromInput);
  $("file-img").addEventListener("change", addFilesFromInput);

  // --- Attach menu (the ＋): Files / Images / Paste image / URL. ----------------------------
  var attachMenu = $("attach-menu");
  function closeAttachMenu() { attachMenu.style.display = "none"; }
  $("attach-btn").addEventListener("click", function (e) {
    e.stopPropagation();
    attachMenu.style.display = attachMenu.style.display === "none" ? "block" : "none";
  });
  document.addEventListener("click", function (e) {
    if (attachMenu.style.display !== "none" && !(e.target.closest && e.target.closest("#attach-wrap"))) closeAttachMenu();
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && attachMenu.style.display !== "none") closeAttachMenu();
  });
  attachMenu.addEventListener("click", function (e) {
    var b = e.target.closest && e.target.closest("button[data-attach]");
    if (!b) return;
    closeAttachMenu();
    var kind = b.getAttribute("data-attach");
    if (kind === "files") $("file").click();
    else if (kind === "images") $("file-img").click();
    else if (kind === "paste") pasteImageFromClipboard();
    else if (kind === "url") attachUrl();
  });

  // Read an image straight off the OS clipboard (needs the async clipboard API + permission;
  // pasting with ⌘V into the composer works regardless via the paste handler below).
  function pasteImageFromClipboard() {
    if (!navigator.clipboard || !navigator.clipboard.read) {
      toast("Clipboard access isn't available here — paste into the message box instead.", true);
      return;
    }
    navigator.clipboard.read().then(function (items) {
      var found = false;
      items.forEach(function (item) {
        var type = (item.types || []).filter(function (t) { return t.indexOf("image/") === 0; })[0];
        if (!type) return;
        found = true;
        item.getType(type).then(function (blob) {
          fileToAttachment(new File([blob], "pasted-image." + (type.split("/")[1] || "png"), { type: type }))
            .then(function (a) { pending.push(a); renderChips(); });
        });
      });
      if (!found) toast("No image on the clipboard.");
    }).catch(function () { toast("Couldn't read the clipboard — paste into the message box instead.", true); });
  }

  // Attach a URL: drops the link into the message so the agent fetches it server-side
  // (web_fetch) — nothing to upload from here.
  function attachUrl() {
    promptDialog({ title: "Attach URL", placeholder: "https://…", action: "Add" }, function (url) {
      url = url.trim();
      if (!url) return;
      if (!/^https?:\/\//i.test(url)) url = "https://" + url;
      var input = $("text");
      input.value = (input.value ? input.value.replace(/\s+$/, "") + "\n" : "") + url;
      input.dispatchEvent(new Event("input"));
      input.focus();
    });
  }

  // ⌘V straight into the composer: images on the clipboard become attachments.
  $("text").addEventListener("paste", function (e) {
    var items = (e.clipboardData && e.clipboardData.items) || [];
    var files = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].kind === "file" && items[i].type.indexOf("image/") === 0) {
        var f = items[i].getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return;
    e.preventDefault();
    Promise.all(files.map(fileToAttachment)).then(function (atts) { pending = pending.concat(atts); renderChips(); });
  });

  // --- Dictation: record → POST /transcribe (server whisper) → text lands in the composer.
  // The mic only shows when /status says the stack can transcribe.
  var micRec = null;
  function micAvailable(on) {
    $("mic").style.display = on && navigator.mediaDevices && window.MediaRecorder ? "" : "none";
  }
  $("mic").addEventListener("click", function () {
    var btn = $("mic");
    if (btn.classList.contains("busy")) return;
    if (micRec) { micRec.stop(); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      var rec = new MediaRecorder(stream);
      var chunksArr = [];
      micRec = rec;
      btn.classList.add("rec");
      rec.addEventListener("dataavailable", function (e) { if (e.data && e.data.size) chunksArr.push(e.data); });
      rec.addEventListener("stop", function () {
        stream.getTracks().forEach(function (t) { t.stop(); });
        micRec = null;
        btn.classList.remove("rec");
        var blob = new Blob(chunksArr, { type: rec.mimeType || "audio/webm" });
        if (!blob.size) return;
        btn.classList.add("busy");
        var fr = new FileReader();
        fr.onload = function () {
          var b64 = String(fr.result).split(",")[1] || "";
          fetch("/transcribe", {
            method: "POST", headers: authHeaders(),
            body: JSON.stringify({ audio: b64, mediaType: blob.type }),
          })
            .then(function (r) {
              if (on401(r)) return null;
              if (!r.ok) { failReason(r).then(function (why) { toast("Dictation failed: " + why, true); }); return null; }
              return r.json();
            })
            .then(function (j) {
              btn.classList.remove("busy");
              if (!j || !j.text) return;
              var input = $("text");
              input.value = (input.value ? input.value.replace(/\s+$/, "") + " " : "") + j.text.trim();
              input.dispatchEvent(new Event("input"));
              input.focus();
            })
            .catch(function () { btn.classList.remove("busy"); toast("Dictation failed — network error.", true); });
        };
        fr.readAsDataURL(blob);
      });
      rec.start();
    }).catch(function () { toast("Microphone unavailable — check browser permissions.", true); });
  });

  // --- Stop button: while a turn is in flight the Send button becomes Stop. ---------------
  var turnActive = false;
  function setTurnActive(on) {
    turnActive = on;
    var b = $("send");
    if (!b) return;
    // Icon-sized button; CSS swaps the glyph (arrow ⇄ square) on the .stop class.
    b.title = on ? "Stop this turn" : "Send (Enter)";
    b.classList.toggle("stop", on);
  }
  function stopTurn() {
    var body = { externalUserId: uid };
    if (convId) body.conversationId = convId;
    fetch("/abort", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || !j.stopped) statusEl.textContent = "nothing to stop";
      })
      .catch(function () { statusEl.textContent = "stop failed"; });
  }

  // --- Execution placement (WS6e): local (the connected executor) vs server. The toggle
  // only shows when /status reports an executor for this user; preference persists.
  var executorConnected = false;
  var executorHost = ""; // hostname of the connected executor machine (from /status)
  var execMode = LS.getItem("dae_exec") === "server" ? "server" : "local";
  function renderExecToggle() {
    var b = $("exec-toggle");
    if (!b) return;
    b.style.display = executorConnected ? "" : "none";
    // "Local" means the user's connected executor machine (dae remote / desktop app) —
    // name it, so it never reads as "this browser".
    var shortHost = (executorHost || "").split(".")[0];
    b.textContent = execMode === "local" ? "⌁ " + (shortHost ? shortHost.slice(0, 18) : "local") : "☁ server";
    b.classList.toggle("local", execMode === "local");
    b.title = execMode === "local"
      ? "Commands run on " + (executorHost || "your machine") + " (your connected dae remote / desktop app). Click to run on the server instead."
      : "Commands run on the server. Click to run on " + (executorHost || "your machine") + ".";
  }
  $("exec-toggle").addEventListener("click", function () {
    execMode = execMode === "local" ? "server" : "local";
    LS.setItem("dae_exec", execMode);
    renderExecToggle();
  });

  function send() {
    if (turnActive) { stopTurn(); return; }
    var text = $("text").value.trim();
    if (!text && !pending.length) return;
    suppressedText = ""; // any held-back text from an aborted whole-reply turn is stale now
    var atts = pending.slice();
    var body = { externalUserId: uid };
    if (convId) body.conversationId = convId;
    if (executorConnected) body.execution = execMode;
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
    setTurnActive(true);
    fetch("/messages", { method: "POST", headers: authHeaders(), body: JSON.stringify(body) })
      .then(function (r) { if (on401(r)) { hideThinking(); stopTurnTimer(); setTurnActive(false); return; } if (!r.ok) { hideThinking(); stopTurnTimer(); setTurnActive(false); statusEl.textContent = "send failed (" + r.status + ")"; } })
      .catch(function () { hideThinking(); stopTurnTimer(); setTurnActive(false); statusEl.textContent = "send failed"; });
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
    var m = $("text").value.match(/^\/([A-Za-z0-9_-]*)$/);
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

  // Sidebar search: a client-side title filter (the full list is already loaded). Grouped
  // rendering: PINNED first, then SESSIONS with a count — the Hermes-style layout.
  var convoQuery = "";

  function convoRow(c) {
    var row = document.createElement("div");
    row.className = "convo" + (c.id === convId ? " active" : "") + (c.pinned ? " pinned" : "");
    row.setAttribute("data-id", c.id);
    var t = document.createElement("span");
    t.className = "title";
    t.textContent = convLabel(c);
    row.appendChild(t);
    var pin = document.createElement("button");
    pin.className = "pin"; pin.type = "button"; pin.title = c.pinned ? "Unpin" : "Pin";
    pin.textContent = c.pinned ? "✦" : "✧";
    pin.setAttribute("data-pin", c.id);
    row.appendChild(pin);
    var del = document.createElement("button");
    del.className = "del"; del.type = "button"; del.title = "Delete conversation";
    del.textContent = "✕";
    del.setAttribute("data-del", c.id);
    row.appendChild(del);
    return row;
  }

  function renderConversations() {
    var listEl = $("convo-list");
    listEl.innerHTML = "";
    var q = convoQuery.toLowerCase();
    var visible = conversations.filter(function (c) {
      return !q || convLabel(c).toLowerCase().indexOf(q) !== -1;
    });
    var pinned = visible.filter(function (c) { return c.pinned; });
    var rest = visible.filter(function (c) { return !c.pinned; });
    function group(label, items, showCount) {
      if (!items.length) return;
      var g = document.createElement("div");
      g.className = "convo-group";
      g.appendChild(document.createTextNode(label));
      if (showCount) {
        var n = document.createElement("span");
        n.className = "n";
        n.textContent = String(items.length);
        g.appendChild(n);
      }
      listEl.appendChild(g);
      items.forEach(function (c) { listEl.appendChild(convoRow(c)); });
    }
    group("Pinned", pinned, false);
    group("Sessions", rest, true);
    if (!visible.length) {
      var e = document.createElement("div");
      e.className = "convo-group";
      e.textContent = q ? "No matches" : "No sessions";
      listEl.appendChild(e);
    }
    // The chat header shows the active conversation's label.
    var active = conversations.filter(function (c) { return c.id === convId; })[0];
    var titleEl = $("convo-title");
    if (titleEl) titleEl.textContent = active ? convLabel(active) : "Daedalus";
  }

  // Optimistic pin toggle; reverted if the server rejects it.
  function togglePin(id) {
    var c = conversations.filter(function (x) { return x.id === id; })[0];
    if (!c) return;
    var want = !c.pinned;
    c.pinned = want;
    renderConversations();
    fetch("/conversations?externalUserId=" + encodeURIComponent(uid), {
      method: "PATCH", headers: authHeaders(), body: JSON.stringify({ id: id, pinned: want }),
    })
      .then(function (r) { if (on401(r)) return; if (!r.ok) { c.pinned = !want; renderConversations(); } })
      .catch(function () { c.pinned = !want; renderConversations(); });
  }

  // Two-row Unicode block font for the empty-chat splash. Each glyph is [top, bottom];
  // letters outside the map (accents, digits) drop the art in favour of plain text.
  var BLOCK_FONT = {
    A: ["▄▀█", "█▀█"], B: ["█▀▄", "█▄█"], C: ["█▀▀", "█▄▄"], D: ["█▀▄", "█▄▀"],
    E: ["█▀▀", "██▄"], F: ["█▀▀", "█  "], G: ["█▀▀", "█▄█"], H: ["█ █", "█▀█"],
    I: ["█", "█"], J: ["  █", "█▄█"], K: ["█▄▀", "█ █"], L: ["█  ", "█▄▄"],
    M: ["█▀▄▀█", "█ ▀ █"], N: ["█▄ █", "█ ▀█"], O: ["█▀█", "█▄█"], P: ["█▀█", "█▀▀"],
    Q: ["█▀█", "█▄▀"], R: ["█▀█", "█▀▄"], S: ["█▀", "▄█"], T: ["▀█▀", " █ "],
    U: ["█ █", "█▄█"], V: ["█ █", "▀▄▀"], W: ["█ █ █", "▀▄▀▄▀"], X: ["▀▄▀", "▄▀▄"],
    Y: ["█ █", " █ "], Z: ["▀▀█", "█▄▄"], " ": ["  ", "  "],
  };
  function blockArt(name) {
    var top = [], bottom = [];
    for (var i = 0; i < name.length; i++) {
      var g = BLOCK_FONT[name[i]];
      if (!g) return null;
      top.push(g[0]);
      bottom.push(g[1]);
    }
    var art = top.join(" ") + "\n" + bottom.join(" ");
    // Longer names would overflow small screens as art; plain text handles those.
    return top.join(" ").length > 52 ? null : art;
  }
  function splashHtml() {
    var name = String(ASSISTANT_NAME || "").toUpperCase();
    var art = name ? blockArt(name) : null;
    return '<div class="empty splash">' +
      (art ? '<pre class="splash-art">' + esc(art) + "</pre>"
           : '<div class="splash-name">' + esc(name || "DAEDALUS") + "</div>") +
      '<div class="splash-hint">say hello</div></div>';
  }

  // Reset the chat view to empty (used when switching/deleting conversations).
  function clearLog() {
    convo = [];
    if (selecting) exitSelect();
    log.innerHTML = splashHtml();
    newSinceScrolled = 0;
    pill.classList.remove("on");
    // Drop any in-progress streamed bubble state so it can't bleed across conversations.
    if (renderTimer) { clearTimeout(renderTimer); renderTimer = null; }
    stopTurnTimer();
    streamBubble = null;
    lastStreamDiv = null;
    lastStreamed = null;
    suppressedText = "";
    // The context readout + stop state belong to the conversation we just left.
    hideContext();
    setTurnActive(false);
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
      .then(function (r) {
        if (on401(r)) return null;
        if (!r.ok) {
          failReason(r).then(function (why) { toast("Couldn't start a new session: " + why, true); });
          return null;
        }
        return r.json();
      })
      .then(function (c) {
        creatingConvo = false;
        if (!c || !c.id) return;
        var known = conversations.some(function (x) { return x.id === c.id; });
        if (!known) conversations.unshift(c);
        selectConversation(c.id);
      })
      .catch(function () { creatingConvo = false; toast("Couldn't start a new session — network error.", true); });
  }

  // Transient notice, bottom-center. Errors must be LOUD — the status-bar text is easy to
  // miss, and a failed delete that "does nothing" reads as a dead button (casa, 2026-07).
  var toastTimer = null;
  function toast(msg, isErr) {
    var el = $("toast");
    el.textContent = msg;
    el.className = isErr ? "err" : "";
    el.style.display = "block";
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.style.display = "none"; }, isErr ? 6000 : 3500);
  }

  // In-house confirm dialog, styled like the app (the browser-native confirm looks alien
  // and can't be themed). cb fires only on confirm. Esc / Cancel / overlay click dismiss.
  // With opts.placeholder the dialog grows a text input and cb receives its value
  // (promptDialog) — Enter confirms.
  function confirmDialog(opts, cb) {
    $("confirm-title").textContent = opts.title || "Are you sure?";
    $("confirm-msg").textContent = opts.message || "";
    $("confirm-yes").textContent = opts.action || "Delete";
    $("confirm-yes").classList.toggle("neutral", Boolean(opts.neutral));
    var field = $("confirm-input");
    var withInput = "placeholder" in opts;
    field.style.display = withInput ? "" : "none";
    field.value = "";
    field.placeholder = opts.placeholder || "";
    var ov = $("confirm-overlay");
    ov.style.display = "flex";
    function close() {
      ov.style.display = "none";
      $("confirm-yes").removeEventListener("click", yes);
      $("confirm-no").removeEventListener("click", close);
      ov.removeEventListener("click", onOverlay);
      document.removeEventListener("keydown", onKey);
    }
    function yes() { var v = field.value; close(); cb(v); }
    function onOverlay(e) { if (e.target === ov) close(); }
    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); close(); }
      if (e.key === "Enter" && withInput && document.activeElement === field) yes();
    }
    $("confirm-yes").addEventListener("click", yes);
    $("confirm-no").addEventListener("click", close);
    ov.addEventListener("click", onOverlay);
    document.addEventListener("keydown", onKey);
    (withInput ? field : $("confirm-no")).focus();
  }
  function promptDialog(opts, cb) {
    confirmDialog({
      title: opts.title,
      message: opts.message,
      action: opts.action || "OK",
      neutral: true,
      placeholder: opts.placeholder || "",
    }, cb);
  }

  // Pull a human-readable reason out of an error response (JSON {error} or raw text).
  function failReason(r) {
    return r.text().then(function (t) {
      try { t = JSON.parse(t).error || t; } catch (e) { /* raw text is fine */ }
      return "HTTP " + r.status + (t ? " — " + String(t).slice(0, 140) : "");
    }).catch(function () { return "HTTP " + r.status; });
  }

  function deleteConversation(id) {
    var match = conversations.filter(function (x) { return x.id === id; })[0];
    var label = match ? convLabel(match) : "this conversation";
    confirmDialog({
      title: "Delete session",
      message: '"' + label + '" and its history will be removed. This cannot be undone.',
      action: "Delete",
    }, function () { doDeleteConversation(id); });
  }
  function doDeleteConversation(id) {
    fetch("/conversations?externalUserId=" + encodeURIComponent(uid) + "&id=" + encodeURIComponent(id),
          { method: "DELETE", headers: authHeaders() })
      .then(function (r) {
        if (on401(r)) return;
        if (!r.ok) { failReason(r).then(function (why) { toast("Couldn't delete the session: " + why, true); }); return; }
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
      .catch(function () { toast("Couldn't delete the session — network error.", true); });
  }

  // Optimistic local title for an unnamed conversation (mirrors the server's auto-title from
  // the first user message) so the sidebar label updates the instant you hit send.
  function maybeTitleCurrent(text) {
    var c = conversations.filter(function (x) { return x.id === convId; })[0];
    if (!c || c.title) return;
    var first = text.split("\n").map(function (l) { return l.trim(); }).filter(Boolean)[0] || "";
    var t = first.replace(/\s+/g, " ").trim();
    if (!t) return;
    c.title = t.length > 50 ? t.slice(0, 49) + "…" : t;
    renderConversations();
  }

  $("sb-toggle").addEventListener("click", function () { document.body.classList.toggle("sb-open"); });
  $("sb-scrim").addEventListener("click", closeSidebar);
  $("new-convo").addEventListener("click", newConversation);
  $("convo-search").addEventListener("input", function () {
    convoQuery = this.value.trim();
    renderConversations();
  });
  $("convo-list").addEventListener("click", function (e) {
    var del = e.target && e.target.closest && e.target.closest(".del");
    if (del) { e.stopPropagation(); deleteConversation(del.getAttribute("data-del")); return; }
    var pin = e.target && e.target.closest && e.target.closest(".pin");
    if (pin) { e.stopPropagation(); togglePin(pin.getAttribute("data-pin")); return; }
    var row = e.target && e.target.closest && e.target.closest(".convo");
    if (row) selectConversation(row.getAttribute("data-id"));
  });

  // --- Status bar -------------------------------------------------------------------------
  // Left: gateway (SSE) state + supervisor snapshot (agents / cron, polled from /status).
  // Right: context-window fill (from turn_done), session timer, client/backend versions.
  function setGateway(state) {
    var dot = $("st-gw-dot");
    if (!dot) return;
    dot.className = "dot " + state;
    $("st-gw").textContent =
      state === "ok" ? "Gateway ready" : state === "warn" ? "Gateway reconnecting…" : "Gateway offline";
  }

  function updateContext(ctx) {
    var el = $("st-context");
    if (!el) return;
    el.style.display = "inline-flex";
    function k(n) { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }
    var fill = $("st-ctx-fill");
    if (ctx.window) {
      var pct = Math.min(100, Math.round((ctx.inputTokens / ctx.window) * 100));
      $("st-ctx-text").textContent = k(ctx.inputTokens) + "/" + k(ctx.window);
      $("st-ctx-pct").textContent = pct + "%";
      fill.style.width = pct + "%";
      fill.className = pct >= 90 ? "err" : pct >= 70 ? "warn" : "";
    } else {
      $("st-ctx-text").textContent = k(ctx.inputTokens) + " ctx";
      $("st-ctx-pct").textContent = "";
      fill.style.width = "0";
    }
  }
  function hideContext() {
    var el = $("st-context");
    if (el) el.style.display = "none";
  }

  function loadStatus() {
    fetch("/status?externalUserId=" + encodeURIComponent(uid), { headers: authHeaders() })
      .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
      .then(function (s) {
        if (!s) return;
        if (s.agents && s.agents.count != null) $("st-agents-n").textContent = String(s.agents.count);
        if (s.schedules) {
          $("st-cron-n").textContent = String((s.schedules.static || 0) + (s.schedules.dynamic || 0));
        }
        if (s.version) $("st-backend").textContent = "backend v" + s.version;
        // Executor state drives the composer's local/server toggle.
        executorConnected = Boolean(s.remoteExec && s.remoteExec.connected);
        executorHost = (s.remoteExec && s.remoteExec.env && s.remoteExec.env.hostname) || "";
        renderExecToggle();
        // Dictation mic only when the stack can transcribe (whisper configured).
        micAvailable(Boolean(s.dictation));
        // Channel threads in the sidebar footer (Hermes-style): each enabled messaging
        // channel gets a section with the cross-channel Main thread — click to open the
        // same conversation your Telegram/WhatsApp messages land in.
        var foot = $("sb-channels");
        if (foot && s.channels) {
          foot.innerHTML = "";
          s.channels.forEach(function (name) {
            if (name === "web" || name === "cli") return;
            var head = document.createElement("div");
            head.className = "sb-ch-head";
            var d = document.createElement("i");
            d.className = "dot";
            head.appendChild(d);
            head.appendChild(document.createTextNode(name + " "));
            var n = document.createElement("span");
            n.className = "n";
            n.textContent = "1";
            head.appendChild(n);
            foot.appendChild(head);
            var thread = row("Main thread", "shared cross-channel conversation");
            thread.className = "sb-item-row jump";
            thread.addEventListener("click", function () {
              if (defaultConvId && defaultConvId !== convId) selectConversation(defaultConvId);
            });
            foot.appendChild(thread);
          });
        }
      })
      .catch(function () { /* the bar degrades quietly */ });
  }
  setGateway("warn");
  loadStatus();
  // 20s (was 60): the exec toggle must disappear promptly when the user's executor
  // dies, or "⌁ local" offers a machine that can no longer run anything.
  setInterval(loadStatus, 20000);

  // --- Status-bar popovers: agents (+ live activity) and cron. The status-bar items are
  // the buttons — clicking toggles an anchored panel, like the reference app. ---------------
  function row(title, sub, subClass) {
    var el = document.createElement("div");
    el.className = "sb-item-row";
    el.appendChild(document.createTextNode(title));
    if (sub) {
      var s = document.createElement("span");
      s.className = "sub" + (subClass ? " " + subClass : "");
      s.textContent = sub;
      el.appendChild(s);
    }
    return el;
  }
  function group(list, label) {
    var g = document.createElement("div");
    g.className = "pop-group";
    g.textContent = label;
    list.appendChild(g);
  }
  var popOpen = null; // "agents" | "cron" | null
  var popOpenedAt = 0; // guards a double-dispatched click from instantly re-closing it
  function closePopover() {
    popOpen = null;
    $("popover").style.display = "none";
  }
  function openPopover(kind, title, anchorId) {
    popOpen = kind;
    popOpenedAt = Date.now();
    $("pop-title").textContent = title;
    $("pop-body").innerHTML = "";
    var pop = $("popover");
    pop.style.display = "block";
    // Anchor above the clicked status item (clamped to the viewport).
    var r = $(anchorId).getBoundingClientRect();
    pop.style.left = Math.max(8, Math.min(r.left - 8, window.innerWidth - pop.offsetWidth - 8)) + "px";
    return $("pop-body");
  }
  $("pop-close").addEventListener("click", closePopover);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && popOpen) closePopover(); });
  document.addEventListener("click", function (e) {
    if (!popOpen) return;
    if (e.target.closest && (e.target.closest("#popover") || e.target.closest(".st-btn"))) return;
    closePopover();
  });

  function fmtSince(iso) {
    var s = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000));
    var m = Math.floor(s / 60);
    return m ? m + "m" + (s % 60) + "s" : s + "s";
  }

  // Agents · Activity modal (the status-bar agents button): fills 90% of the viewport.
  // Roster on the left — agents with an in-flight turn on top (live dot + elapsed), idle
  // agents greyed underneath. Clicking one shows its detail on the right: the live turn
  // (what it's doing, where, jump-to-conversation) or the manifest facts when idle.
  var agSelected = null; // survives live refreshes while the modal is open
  var agFlowPinned = true; // follow the newest step until the user scrolls up
  var agFlowScroll = 0;
  var agRefresh = null; // fast poll while the modal is open (the 8s bar poll is too slow to feel live)
  function renderAgentsModal() {
    if (panelKind !== "agents") {
      openPanel("Agents · Activity", "agents");
      agFlowPinned = true;
    }
    clearTimeout(agRefresh);
    agRefresh = setTimeout(function () { if (panelKind === "agents") renderAgentsModal(); }, 2500);
    var body = $("panel-body");
    Promise.all([
      fetch("/activity?externalUserId=" + encodeURIComponent(uid), { headers: authHeaders() })
        .then(function (r) { return r.ok ? r.json() : { turns: [] }; })
        .catch(function () { return { turns: [] }; }),
      fetch("/agents?externalUserId=" + encodeURIComponent(uid), { headers: authHeaders() })
        .then(function (r) { return r.ok ? r.json() : { agents: [] }; })
        .catch(function () { return { agents: [] }; }),
    ]).then(function (res) {
      if (panelKind !== "agents") return; // closed while fetching
      var turns = res[0].turns || [], roster = res[1].agents || [];
      // The orchestrator is the chat itself — its own activity streams there. This view is
      // the SUB-agents: what's been delegated and what each delegate is doing right now.
      roster = roster.filter(function (a) { return !a.orchestrator; });
      // Attribute activity to sub-agents from the turn logs. A sub-agent's steps arrive
      // prefixed with its chain ("cypher · tool: bash", "cypher › reviewer · tool: read",
      // "spawning cypher"); an agent can also BE a turn's top-level agent (a cron firing
      // it directly) — then its whole log belongs to it.
      var busy = {};
      function claim(name, t, step) {
        if (!busy[name]) busy[name] = { steps: [], channel: t.channel, startedAt: step.at || t.startedAt };
        busy[name].steps.push(step);
      }
      turns.forEach(function (t) {
        var steps = (t.log && t.log.length) ? t.log : [{ at: t.startedAt, label: t.activity || "working" }];
        steps.forEach(function (s) {
          roster.forEach(function (a) {
            var n = a.name;
            if (t.agent === n) { claim(n, t, s); return; }
            if (s.label === "spawning " + n) { claim(n, t, { at: s.at, label: "spawned" }); return; }
            if (s.label.indexOf(n + " · ") === 0) { claim(n, t, { at: s.at, label: s.label.slice(n.length + 3) }); return; }
            if (s.label.indexOf(n + " › ") === 0) { claim(n, t, { at: s.at, label: s.label.slice(n.length + 3) }); }
          });
        });
      });
      var active = roster.filter(function (a) { return busy[a.name]; });
      var idle = roster.filter(function (a) { return !busy[a.name]; });
      active.sort(function (a, b) { return busy[a.name].startedAt.localeCompare(busy[b.name].startedAt); });
      var ordered = active.concat(idle);
      if (!agSelected || !roster.some(function (a) { return a.name === agSelected; })) {
        agSelected = ordered.length ? ordered[0].name : null;
      }

      body.innerHTML = "";
      var list = document.createElement("div");
      list.className = "ag-list";
      var detail = document.createElement("div");
      detail.className = "ag-detail";
      body.appendChild(list);
      body.appendChild(detail);

      function renderDetail() {
        detail.innerHTML = "";
        var a = roster.filter(function (x) { return x.name === agSelected; })[0];
        if (!a) { detail.innerHTML = '<div class="ag-empty">No sub-agents in the brain.</div>'; return; }
        var t = busy[a.name];
        var h = document.createElement("h2");
        h.textContent = a.name + " ";
        var badge = document.createElement("span");
        badge.className = "ag-state" + (t ? " busy" : "");
        badge.textContent = t ? "active" : "idle";
        h.appendChild(badge);
        detail.appendChild(h);
        if (a.description) {
          var d = document.createElement("div");
          d.className = "ag-desc";
          d.textContent = a.description;
          detail.appendChild(d);
        }
        if (t) {
          // This sub-agent's inner life, flowing: thinking snippets, tool calls with
          // their inputs, failures — its steps attributed out of the turn logs.
          var live = document.createElement("div");
          live.className = "ag-live";
          var meta = document.createElement("div");
          meta.className = "ag-live-meta";
          meta.textContent = "via " + t.channel + " · working " + fmtSince(t.startedAt);
          live.appendChild(meta);
          var flow = document.createElement("div");
          flow.className = "ag-flow";
          t.steps.forEach(function (s) {
            var stepEl = document.createElement("div");
            stepEl.className = "ag-step" +
              (s.label.indexOf("thinking") >= 0 ? " think" : "") +
              (s.label.indexOf("tool failed") >= 0 ? " fail" : s.label.indexOf("tool:") >= 0 ? " tool" : "");
            var tm = document.createElement("span");
            tm.className = "t";
            tm.textContent = String(s.at).slice(11, 19);
            var lb = document.createElement("span");
            lb.className = "l";
            lb.textContent = s.label;
            stepEl.appendChild(tm);
            stepEl.appendChild(lb);
            flow.appendChild(stepEl);
          });
          live.appendChild(flow);
          detail.appendChild(live);
          // Follow the newest step unless the user scrolled up to read history.
          flow.scrollTop = agFlowPinned ? flow.scrollHeight : agFlowScroll;
          flow.addEventListener("scroll", function () {
            agFlowPinned = flow.scrollHeight - flow.scrollTop - flow.clientHeight < 30;
            agFlowScroll = flow.scrollTop;
          });
        }
        var kv = document.createElement("dl");
        kv.className = "ag-kv";
        function fact(k, v) {
          if (!v) return;
          var dt = document.createElement("dt");
          dt.textContent = k;
          var dd = document.createElement("dd");
          dd.textContent = v;
          kv.appendChild(dt);
          kv.appendChild(dd);
        }
        fact("Model", a.model);
        fact("Runs in", a.image ? "docker · " + a.image : a.execution ? a.execution : "");
        fact("Sub-agents", (a.subagents || []).join(", "));
        fact("Tools", (a.tools || []).join(", "));
        fact("Schedule", a.schedule);
        if (kv.children.length) detail.appendChild(kv);
      }

      function renderList() {
        list.innerHTML = "";
        ordered.forEach(function (a) {
          var t = busy[a.name];
          var el = document.createElement("button");
          el.type = "button";
          el.className = "ag-row" + (t ? " busy" : " idle") + (a.name === agSelected ? " sel" : "");
          var dot = document.createElement("i");
          dot.className = "ag-dot";
          var txt = document.createElement("span");
          txt.style.minWidth = "0";
          var nm = document.createElement("span");
          nm.className = "ag-name";
          nm.textContent = a.name;
          var sub = document.createElement("span");
          sub.className = "ag-sub";
          sub.textContent = t
            ? (t.steps[t.steps.length - 1].label || "working") + " · " + fmtSince(t.startedAt)
            : a.model || a.description || "";
          txt.appendChild(nm);
          txt.appendChild(sub);
          el.appendChild(dot);
          el.appendChild(txt);
          el.addEventListener("click", function () {
            agSelected = a.name;
            agFlowPinned = true; // fresh agent — follow its newest steps
            renderList();
            renderDetail();
          });
          list.appendChild(el);
        });
        if (!ordered.length) list.innerHTML = '<div class="ag-empty">No sub-agents in the brain.</div>';
      }

      renderList();
      renderDetail();
    });
  }

  function renderCronPopover() {
    var body = openPopover("cron", "Schedules", "st-cron");
    fetch("/schedules?externalUserId=" + encodeURIComponent(uid), { headers: authHeaders() })
      .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j || popOpen !== "cron") return;
        body.innerHTML = "";
        var statics = j.static || [], dyn = j.dynamic || [];
        if (statics.length) group(body, "Brain schedules");
        statics.forEach(function (s) {
          body.appendChild(row(s.name, s.schedule + " · " + s.agent + (s.enabled ? "" : " · disabled"), s.enabled ? "" : "off"));
        });
        if (dyn.length) group(body, "Agent-armed");
        dyn.forEach(function (d) {
          var when = d.recurring ? d.recurring : ("next " + String(d.nextFire || "").replace("T", " ").slice(0, 16));
          body.appendChild(row(d.prompt || d.id, when + " · " + d.agent));
        });
        if (!statics.length && !dyn.length) body.appendChild(row("(nothing scheduled)", ""));
      })
      .catch(function () {});
  }

  $("st-agents").addEventListener("click", function () {
    if (panelKind === "agents") { closePanel(); return; }
    closePopover();
    renderAgentsModal();
  });
  $("st-cron").addEventListener("click", function () {
    if (popOpen === "cron" && Date.now() - popOpenedAt > 250) { closePopover(); return; }
    renderCronPopover();
  });

  // --- Modal panels: Skills & Tools / Artifacts (sidebar nav) + Agents (status bar) ---------
  var panelKind = null; // "skills" | "artifacts" | "agents" | null
  function closePanel() {
    panelKind = null;
    clearTimeout(agRefresh); // stop the agents modal's fast poll
    $("panel").classList.remove("xl");
    $("panel-overlay").style.display = "none";
  }
  function openPanel(title, kind) {
    panelKind = kind || null;
    // The agents view is a near-fullscreen two-pane layout; the others are compact lists.
    $("panel").classList.toggle("xl", kind === "agents");
    $("panel-title").textContent = title;
    $("panel-body").innerHTML = "";
    $("panel-overlay").style.display = "flex";
    return $("panel-body");
  }
  $("panel-close").addEventListener("click", closePanel);
  $("panel-overlay").addEventListener("click", function (e) { if (e.target === $("panel-overlay")) closePanel(); });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && $("panel-overlay").style.display !== "none") closePanel();
  });

  function pRow(title, badges, sub, actions) {
    var el = document.createElement("div");
    el.className = "p-row";
    var main = document.createElement("div");
    main.className = "main";
    var t = document.createElement("div");
    t.className = "title";
    t.appendChild(document.createTextNode(title));
    (badges || []).forEach(function (b) {
      var s = document.createElement("span");
      s.className = "badge " + (b.cls || "");
      s.textContent = b.label;
      t.appendChild(s);
    });
    main.appendChild(t);
    if (sub) {
      var d = document.createElement("span");
      d.className = "sub";
      d.textContent = sub;
      d.title = sub;
      main.appendChild(d);
    }
    el.appendChild(main);
    if (actions && actions.length) {
      var act = document.createElement("div");
      act.className = "p-act";
      actions.forEach(function (a) { act.appendChild(a); });
      el.appendChild(act);
    }
    return el;
  }
  function actBtn(label, cls, fn) {
    var b = document.createElement("button");
    b.type = "button";
    if (cls) b.className = cls;
    b.textContent = label;
    b.addEventListener("click", fn);
    return b;
  }
  function skillAction(name, action) {
    fetch("/skills/action?externalUserId=" + encodeURIComponent(uid), {
      method: "POST", headers: authHeaders(), body: JSON.stringify({ name: name, action: action }),
    })
      .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
      .then(function (j) {
        if (j && !j.ok) statusEl.textContent = "skill " + action + " failed: " + (j.error || "unknown");
        renderSkillsPanel();
      })
      .catch(function () { statusEl.textContent = "skill " + action + " failed"; });
  }
  function renderSkillsPanel() {
    var body = openPanel("Skills & Tools", "skills");
    fetch("/skills?externalUserId=" + encodeURIComponent(uid), { headers: authHeaders() })
      .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        body.innerHTML = "";
        var writable = Boolean(j.writable);
        if (!writable) {
          var note = document.createElement("div");
          note.className = "panel-note";
          note.textContent = "Brain is read-only — lifecycle actions are disabled (brain.writable).";
          body.appendChild(note);
        }
        var pending = j.pending || [];
        if (pending.length) {
          group(body, "Pending approval");
          pending.forEach(function (p) {
            body.appendChild(pRow(
              p.name,
              [{ label: p.patchesExisting ? "patch" : "new", cls: "pending" }],
              p.description,
              writable ? [
                actBtn("Approve", "ok", function () { skillAction(p.name, "approve"); }),
                actBtn("Reject", "danger", function () { skillAction(p.name, "reject"); }),
              ] : [],
            ));
          });
        }
        group(body, "Skills");
        (j.skills || []).forEach(function (s) {
          var badges = [];
          if (s.origin === "agent") badges.push({ label: "agent", cls: "agent" });
          if (s.status === "stale") badges.push({ label: "stale", cls: "stale" });
          if (s.pinned) badges.push({ label: "✦ pinned", cls: "agent" });
          var actions = [];
          if (writable) {
            actions.push(actBtn(s.pinned ? "Unpin" : "Pin", "", function () {
              skillAction(s.name, s.pinned ? "unpin" : "pin");
            }));
            if (s.origin === "agent") {
              actions.push(actBtn("Archive", "danger", function () {
                confirmDialog({
                  title: "Archive skill",
                  message: "'" + s.name + "' will move to skills/.archive (recoverable).",
                  action: "Archive",
                }, function () { skillAction(s.name, "archive"); });
              }));
            }
          }
          body.appendChild(pRow(s.name, badges, s.description || "(no description)", actions));
        });
        if (!(j.skills || []).length && !pending.length) body.appendChild(pRow("(no skills)", [], ""));
      })
      .catch(function () {});
  }
  function fmtBytes(n) {
    if (!n && n !== 0) return "";
    if (n >= 1048576) return (n / 1048576).toFixed(1) + " MB";
    if (n >= 1024) return Math.round(n / 1024) + " KB";
    return n + " B";
  }
  function renderArtifactsPanel() {
    var body = openPanel("Artifacts", "artifacts");
    var searchWrap = document.createElement("div");
    searchWrap.className = "panel-search";
    var input = document.createElement("input");
    input.type = "search";
    input.placeholder = "Search files…";
    searchWrap.appendChild(input);
    body.appendChild(searchWrap);
    var list = document.createElement("div");
    body.appendChild(list);
    function load(q) {
      fetch("/artifacts?externalUserId=" + encodeURIComponent(uid) + (q ? "&q=" + encodeURIComponent(q) : ""), { headers: authHeaders() })
        .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
        .then(function (j) {
          if (!j) return;
          list.innerHTML = "";
          (j.files || []).forEach(function (f) {
            var dl = document.createElement("a");
            dl.textContent = "Download";
            dl.href = "/artifacts/file?externalUserId=" + encodeURIComponent(uid) +
              "&ref=" + encodeURIComponent(f.ref) + (token ? "&token=" + encodeURIComponent(token) : "");
            var sub = [f.mediaType, fmtBytes(f.bytes), String(f.uploadedAt || "").slice(0, 10), f.summary]
              .filter(Boolean).join(" · ");
            list.appendChild(pRow(f.filename || f.ref.slice(0, 18) + "…", [], sub, [dl]));
          });
          if (!(j.files || []).length) list.appendChild(pRow(q ? "(no matches)" : "(no files yet)", [], ""));
        })
        .catch(function () {});
    }
    var debounce = null;
    input.addEventListener("input", function () {
      clearTimeout(debounce);
      var q = input.value.trim();
      debounce = setTimeout(function () { load(q); }, 250);
    });
    load("");
  }
  $("nav-skills").addEventListener("click", renderSkillsPanel);
  $("nav-artifacts").addEventListener("click", renderArtifactsPanel);

  // Continuous light poll: pulses the agents button while anything is in flight, shows
  // the active count, and live-refreshes the agents popover when it's open.
  function pollActivity() {
    fetch("/activity?externalUserId=" + encodeURIComponent(uid), { headers: authHeaders() })
      .then(function (r) { if (on401(r)) return null; return r.ok ? r.json() : null; })
      .then(function (j) {
        if (!j) return;
        var n = (j.turns || []).length;
        $("activity-dot").classList.toggle("on", n > 0);
        $("st-active-n").textContent = n ? " · " + n + " active" : "";
        // The agents modal runs its own 2.5s refresh while open — no extra render here.
      })
      .catch(function () { /* the bar degrades quietly */ });
  }
  pollActivity();
  setInterval(pollActivity, 8000);

  // Session timer: time since this page opened (mm:ss, then h:mm:ss).
  var sessionStart = Date.now();
  setInterval(function () {
    var el = $("st-session");
    if (!el) return;
    var s = Math.floor((Date.now() - sessionStart) / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    var pad = function (n) { return (n < 10 ? "0" : "") + n; };
    el.textContent = h ? h + ":" + pad(m) + ":" + pad(ss) : m + ":" + pad(ss);
  }, 1000);

  // Load the conversation list first, then open the active one's history + live stream.
  loadConversations(function () { loadHistory(); connect(); });
  loadCommands();
})();
