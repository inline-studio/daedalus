# Changelog

User-facing changes to daedalus. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is per-commit
to `main` via CI (`v0.1.0-<run>`), so this file groups changes by sync rather than
per individual release tag.

Each entry references the PR that introduced the change.

---

## Unreleased

### Added

- **Webchat: Copy button on code blocks.** Every `<pre><code>` block in
  an assistant reply now has a small "Copy" button in the top-right corner.
  Click → text goes to the clipboard, button briefly reads "Copied!" then
  resets. Inline `` `code` `` stays as-is (too small for a button to be
  worth the noise). Wired via event delegation on `#log` so it works for
  bulk-loaded history and live SSE messages alike. Falls back to a hidden
  `<textarea>` + `execCommand("copy")` on plain-HTTP origins where
  `navigator.clipboard` isn't available. ([#89])

### Fixed

- **Webchat: missing scrollbar in long conversations.** The previous layout
  used `justify-content: flex-end` on the scroll container to anchor
  messages to the bottom. That works when content fits, but a long-standing
  Chromium bug (reproduced in Brave) makes the top of overflowing content
  unreachable — no scrollbar appears at all. Replaced with the
  `margin-top: auto` pattern on the first child: same anchored-to-bottom
  behaviour when underfilled, native scrolling when overflowing. ([#88])

---

## 2026-05-29 — Webchat reliability sweep

### Added

- **Webchat: scrollable history with smart auto-scroll.** A "↓ N new messages"
  pill appears when new content arrives while the viewport is scrolled up;
  clicking it jumps to the bottom and clears the counter. Auto-scroll on
  new messages only happens when the user is already at the bottom; the user's
  own messages always jump to the bottom on send. ([#82])

- **Webchat: SSE resume on reconnect.** Every server-sent event carries an
  `id: <iso>` line so the browser's `EventSource` sets `Last-Event-ID` on the
  next reconnect. The server replays any assistant messages persisted since
  the watermark — replies that landed during a transient disconnect are no
  longer lost. ([#76])

- **Webchat: client-side SSE watchdog.** Proxies (Caddy, Cloudflare, NAT
  middleboxes) sometimes tear down long-lived SSE connections silently — the
  browser thinks the socket is alive but no events arrive. A 15-second-tick
  watchdog detects ≥45 s of no events (≥2 missed heartbeats) and force-
  reconnects, which triggers the Last-Event-ID replay above. ([#82])

- **Webchat: Markdown tables.** GFM tables in assistant replies now render
  as real `<table>` elements. Strict mode: if a paragraph block mixes table
  rows with prose, it falls back to `<p>` rather than silently dropping the
  prose. ([#76])

- **`glob` built-in tool.** Wraps Node 24's `fs.promises.glob` — zero new
  deps, sorted output, default cap 1000 matches (max 5000) so a runaway
  `**/*` pattern can't enumerate the filesystem. ([#73])

- **SSH key auto-mount for agent containers.** Drop key material at
  `<configDir>/ssh/` on the host and every agent container symlinks it into
  `$HOME/.ssh/` on start, with a generated `~/.ssh/config` that disables
  `StrictModes` (the host file's uid almost never matches the container's).
  Agent-written `~/.ssh/<name>` files take precedence over the host-mounted
  defaults. ([#75])

- **Humanised turn-failure messages.** When an agent turn dies, the user no
  longer sees raw `Error: agent worker turn failed (HTTP 500): OpenAI-
  compatible completion failed: Connection error.: …: fetch failed: other
  side closed`. Errors are classified (`upstream-down`, `auth`,
  `rate-limit`, `timeout`, `context-overflow`, `bad-request`,
  `worker-down`) and explained in plain English with a one-line technical
  hint for self-diagnosis. The operator still gets the full stack via
  `log.error`. ([#81])

- **Telegram: structural Markdown rendering.** `# Heading`, GFM tables, and
  `-` / `*` bullet lists now render properly. Telegram HTML has no `<table>`
  or `<ul>` — tables become per-row stanzas (bold row label + `<i>Header</i>:
  value` lines underneath), bullets become `•`, headings become `<b>`.
  Blockquotes get `<blockquote>` (Telegram supports it natively). ([#79])

### Fixed

- **Telegram: `**bold**` was sent as raw text.** The Telegram channel sent
  Claude's CommonMark output verbatim with no `parse_mode`. Now translates
  inline emphasis (bold, italic, code, links, strike, code fences) to
  Telegram's HTML dialect and sets `parse_mode: HTML`. Falls back to
  markers-stripped plain text if Telegram rejects the HTML. ([#74])

- **`dae install` failed on casa with `"/runtime/agent-turn.sh": not found`.**
  The agent-container entrypoint shim was extracted into real files
  (`runtime/{agent-turn.sh,setup-ssh.sh}`) but they weren't added to
  `COMPOSE_FILES` — the install copied the rest of the docker build context
  but left these out. Auto-derived `.dockerignore` from `COMPOSE_FILES` so
  this class of bug can't reappear. ([#77])

- **Connection-error retries didn't fire.** `isTransientLLMError` only walked
  one `.cause` level, but the OpenAI SDK wraps the actual transport signal 3-4
  layers deep (`ProviderError → Error → TypeError → SocketError`). The full
  chain is now flattened and `"other side closed"` / `"premature close"` /
  `"connection refused/aborted"` are recognised. Transient blips now actually
  retry (up to 4 times with exponential backoff). ([#80])

- **Webchat: messages stacked at top of chat area, not bottom.** `#log` was
  `flex-direction: column` with no `justify-content`, so short conversations
  floated at the top of the chat area with empty space below — opposite of
  chat-app convention. Now uses `justify-content: flex-end`. ([#84])

- **Webchat: bulk history load tripped the "new messages" pill.** The smart-
  scroll heuristic incremented the pill counter for messages bulk-loaded
  via `/history` on page reload. Added a `bulkLoading` flag that bypasses
  per-message scroll/pill work; `loadHistory` snaps to the bottom once at
  the end. ([#84])

- **Webchat: `dae update` didn't take effect without a hard refresh.** The
  inline JS/CSS shell HTML was served without `Cache-Control` — browsers
  (and Cloudflare) cached it for hours to days. Added
  `Cache-Control: no-cache, no-store, must-revalidate` + `Pragma: no-cache`
  + `Expires: 0` so future updates land on the next page load. ([#83])

- **Webchat: `/history` lost user messages in tool-heavy sessions.** The
  endpoint pulled the last 50 raw rows from the messages table, but each
  tool-using turn writes two rows (assistant turn + `tool_results` as a
  "user" message that has no text). In a session with many tool round-
  trips, the user's own text questions got pushed out of the 50-row window.
  Raw window is now 1000 rows with a 200-visible-message cap on the response.
  ([#85])

- **Webchat: light upward scrolls got snapped back to the bottom.** The
  scroll listener called `jumpToBottom()` whenever `isAtBottom()` returned
  true, which meant a slight upward scroll within the 60 px threshold was
  immediately yanked back. The listener now only updates pill state;
  scroll-position mutations live solely in `addMsg`. ([#86])

### Changed

- **README restructured.** Section order now: why → what `dae` offers →
  requirements (incl. embeddings) → install + walkthrough → secrets via
  `dae secret` → OneCLI → brain examples → skills + `bootstrap.sh` (with
  the no-`apt-get` caveat and the in-line.studio default images linked) →
  `dae` commands. The deep config / architecture detail moved to `docs/`
  with pointers from the README. ([#78])

---

## Pre-2026-05-29 — Earlier work

Significant changes that shipped before this changelog was started:

- Auto-compaction of conversation history (older tool_result bodies stubbed
  on replay; recent N loops kept full-fidelity).
- Vision / multimodal input (images attached on inbound; routed through a
  configurable vision model when the agent's main model can't see images).
- Skill progressive disclosure (skill bodies load on demand via
  `load_skill`; the system prompt only carries the one-line menu).
- Byte/token-budgeted history window (replaces a fixed message count).
- Graphiti temporal-knowledge-graph memory (replaces the legacy mempalace
  store; auto-injected as the `memory` MCP server for every agent).

---

<!-- PR references -->
[#73]: https://github.com/inline-studio/daedalus/pull/73
[#74]: https://github.com/inline-studio/daedalus/pull/74
[#75]: https://github.com/inline-studio/daedalus/pull/75
[#76]: https://github.com/inline-studio/daedalus/pull/76
[#77]: https://github.com/inline-studio/daedalus/pull/77
[#78]: https://github.com/inline-studio/daedalus/pull/78
[#79]: https://github.com/inline-studio/daedalus/pull/79
[#80]: https://github.com/inline-studio/daedalus/pull/80
[#81]: https://github.com/inline-studio/daedalus/pull/81
[#82]: https://github.com/inline-studio/daedalus/pull/82
[#83]: https://github.com/inline-studio/daedalus/pull/83
[#84]: https://github.com/inline-studio/daedalus/pull/84
[#85]: https://github.com/inline-studio/daedalus/pull/85
[#86]: https://github.com/inline-studio/daedalus/pull/86
[#88]: https://github.com/inline-studio/daedalus/pull/88
[#89]: https://github.com/inline-studio/daedalus/pull/89
