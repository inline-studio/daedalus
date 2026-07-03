# Changelog

User-facing changes to daedalus. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning is per-commit
to `main` via CI (`v0.1.0-<run>`), so this file groups changes by sync rather than
per individual release tag.

Each entry references the PR that introduced the change.

---

## Unreleased

### Added

- **Desktop release workflow.** `.github/workflows/desktop.yml` builds and releases
  the app **automatically on merge to `main`** (path-filtered to `apps/desktop/**`;
  manual dispatch remains, optionally with an explicit version). Gate first — server
  typecheck + CI smoke battery, desktop syntax checks, a headless Electron boot
  smoke — then a three-platform matrix (dmg arm64+x64 / NSIS / AppImage) versioned
  `0.1.<run>`, publishing an immutable `desktop-v<version>` release plus the rolling
  **`desktop-latest`** release that serves as the auto-update feed — the updater uses
  electron-updater's generic provider against it, because the plain GitHub provider
  scans the repo's newest release, which is almost always a *server* release
  (`v0.1.0-<run>`). macOS signing/notarisation activate automatically once the Apple
  credential secrets exist; unsigned builds still release fine.

### Added

- **Executor placement + environment awareness.** A sub-agent can declare
  `execution: executor` in its frontmatter to REQUIRE the user's machine — for
  sub-agent stacks whose tooling lives on the host (host-only CLIs, local projects).
  The orchestrator threads the parent turn's executor grant into exactly those spawns
  (everything else stays server-side) and fails fast with clear guidance when no
  executor is connected. Executors now advertise their machine
  (hostname/platform/arch) on registration, and every remotely-executing turn gets an
  ephemeral execution-environment context line ("bash runs on scotts-mba
  (darwin/arm64), workspace …") so the model stops assuming the server container's
  toolchain and probes with `command -v` instead.

### Added

- **Desktop app: local execution + wizard.** The Electron shell embeds an executor —
  the desktop equivalent of `dae remote`: conversations started in the app run their
  commands and file edits on your machine, in a chosen workspace, with a **native
  approval dialog** per command (Allow / Always allow prefix / Deny; the dangerous-
  pattern denylist always asks, even in free rein). The first successful connect offers
  to enable it (one-time wizard step: workspace picker + approval mode); **Server →
  Local Execution…** changes or disables it later, with live On/Reconnecting/Off state
  in the menu. Executor auth is borrowed from the window itself (login cookie via the
  cookies API, or the web UI's stored uid/token), so it is always the same user as the
  chat; the allowlist and audit log are the same `~/.daedalus/` files the CLI uses, so
  an "always allow" applies across both surfaces. The `--smoke-test` mode now proves
  the executor registers and serves requests end to end.

### Added

- **`dae remote` is a real terminal interface.** Not a bare REPL any more: a
  persistent, hand-rolled-ANSI terminal app (zero new dependencies) with streaming
  replies, dim tool/sub-agent activity lines, a live status line (gateway · session ·
  execution mode · context-window readout · session timer), persisted ↑/↓ history,
  multi-line input via trailing `\`, **Esc to stop the in-flight turn**, Ctrl-C×2 to
  quit, and the full slash-command set (`/stop /new /sessions /agents /crons /activity
  /skills /status /local /yolo /help /quit` — server commands pass through). First run
  with no arguments launches a setup wizard (server URL, auth, workspace, approval
  mode) persisted to `~/.daedalus/remote.json`, so afterwards it's just `dae remote`
  (alias `dae chat`). Executor confirmations render inline as single-key prompts.
  `--plain` (or no TTY) keeps the old line mode; headless stays executor-only. The
  transport, executor, and safety policy moved to a shared core used by both renderers.

### Added

- **Skills & Tools + Artifacts panels.** Two sidebar nav items (the reference layout's
  top-nav) opening modal panels. **Skills**: the live library with badges
  (agent-created / stale / pinned) and the lifecycle actions the self-learning system
  defines — approve/reject the pending queue, pin/unpin (curator exemption), archive
  (agent-created only, recoverable) — via `GET /skills` + `POST /skills/action`; all
  actions gated on `brain.writable` and mirroring `dae skill`'s guard rails. Per-agent
  granting stays in frontmatter by design (no enable/disable switch). **Artifacts**: a
  searchable browser over the per-user attachment catalogue (uploads + agent-generated
  files) with ownership-checked downloads (`GET /artifacts`, `GET /artifacts/file`).
  The remote CLI gains `/skills`.

### Added

- **Live activity view.** The status bar's **agents** button pulses while anything is
  in flight and shows the active count; clicking it opens an Agents · Activity popover —
  in-flight turns across all your conversations AND scheduled fires, each with a live
  label (thinking / replying / `tool: bash` / `cypher · tool: read`), channel, and
  elapsed time, click-to-jump (where the Stop button awaits) — followed by the agent
  roster. The CLI mirrors it as `/activity`. Implemented as a decorator around the
  supervisor's dispatcher — the one choke point every top-level turn flows through —
  feeding an in-memory registry exposed per-user via `GET /activity`. Buffered
  channels' turns (Telegram) are tracked too.

### Added

- **Agents & Cron viewers + per-conversation execution toggle.** The status bar's
  **agents** and **cron** items are now buttons: clicking opens anchored popovers with
  the detail — the agent roster (name, model, docker image, delegation targets — from
  new `GET /agents`) and schedules (static brain schedules + live agent-armed callbacks
  with next fire — `GET /schedules`); the remote CLI gets `/agents` and `/crons`. The
  sidebar shows a Hermes-style section per enabled messaging channel (e.g. TELEGRAM)
  with the cross-channel Main thread, click-to-open; the header is slimmer with proper
  icon buttons.
  When your `dae remote` executor is connected, a `⌁ local / ☁ server` toggle appears in
  the web composer (and `/local on|off` in the CLI) to choose per conversation whether
  the turn's commands run on your machine or the server (`execution` field on
  `POST /messages`); `GET /status` now reports your executor's connection state.

### Added

- **Stop button — abort an in-flight turn.** Premature enter, wrong direction, runaway
  tool loop: the web/desktop Send button becomes **Stop** while a turn streams, and the
  remote CLI takes `/stop`. `POST /abort` (ownership-checked) cancels through whichever
  dispatch mode is running the turn — in-process via AbortSignal (with a new
  between-tools abort check so multi-tool rounds stop promptly), the warm worker via a
  forwarded abort to its per-turn controllers, per-turn containers via force-removal.
  Partial streamed output stays visible; nothing further is persisted; the surface shows
  a quiet "⏹ Stopped." instead of an error.

### Added

- **Remote execution — `dae remote`.** The agent runs on the server; its tools run on
  your machine. The client is one process with two jobs: a chat REPL on the web
  channel, and the executor for your user — the turn's `bash`/`read`/`write`/`edit`
  arrive over an outbound SSE stream, run in your declared workspace, and stream back
  (no open ports on the laptop). Server-side, a new `RemoteRuntime` slots into the
  runtime seam and reaches the laptop via the supervisor's `/rpc/exec` bridge (per-boot
  shared secret), across every dispatch mode. Only turns started from the remote CLI
  execute remotely; subagents and other channels are untouched. Safety: per-command
  confirmation with a persistable allowlist, a never-auto-approved denylist for
  catastrophic patterns (even under `--yolo`), workspace-confined file ops, an audit
  log, and executor-only headless mode that refuses rather than auto-approves. Enable
  with `channels.web.remoteExec.enabled: true`.

### Added

- **Skill self-learning.** Daedalus can now grow its own skill library from experience.
  A new `skill_manage` tool (explicit opt-in, excluded from `tools: ['*']`) lets an agent
  create, patch, extend, and archive skills; a post-turn review pass replays substantial
  turns with only that tool and captures reusable workflows, fixes, and user corrections —
  patch-before-create, class-level skills only, never transient failures. Writes are
  staged under `skills/.pending/` for human review by default (`dae skill
  pending|approve|reject`); live writes are git-committed when the brain is a repo. A
  deterministic weekly curator marks agent-created skills unused 30+ days as stale and
  archives them (never deletes) after 90, driven by a `load_skill` usage tracker; pinned
  and human-authored skills are untouched. Configure under `skills.learning` (off by
  default; requires `brain.writable: true`).

### Added

- **Live sub-agent view.** Delegated work is no longer opaque: when an orchestrator
  calls `spawn_subagent`, the subagent's turn events (tool calls, lifecycle) stream
  back live, tagged with which agent they came from — through every dispatch mode,
  including the per-turn agent containers (which now emit sentinel-framed event lines
  on stdout). The web UI renders each spawn as a collapsible activity panel inside the
  reply (prompt + tool rows resolving ✓/✗ in real time); the CLI prints dim
  `[agent] tool: …` summary lines (`channels.cli.subagentEvents: summary | full | off`).
  Nested spawns group under the top-level panel, labelled by their agent chain. Opt out
  globally with `runtime.subagentEventStream: false`.

### Added

- **Desktop app (Electron shell).** `apps/desktop/` wraps the web UI in a native
  window: native notifications (the UI's 🔔 opt-in), a dock badge counting unread
  replies while the window is in the background, persistent login, external links
  opening in the default browser, and a hidden macOS title bar with the traffic lights
  floating over the sidebar. First launch asks for the server URL; **Server → Change
  Server…** switches later. No daedalus code runs in the shell — it's a client on the
  web channel. `npm start` to run, `npm run dist` for a dmg/AppImage (unsigned;
  signing + auto-update land with the release pipeline). The web UI feature-detects
  the shell via `window.daedalusDesktop`, so the served page is unchanged in browsers.

### Added

- **Web UI v2 — session workspace with a live status bar.** The chat UI is restyled
  (near-black theme, teal accent, user messages as raised cards) and grows a real
  session sidebar — pinned sessions (new `PATCH /conversations`), title search
  (`GET /conversations?q=`), grouped PINNED/SESSIONS lists, and channel badges — plus a
  full-width status bar: gateway (SSE) state, agent and cron counts from a new
  `GET /status` endpoint, a context-window readout (`65.0k/200.0k · 32%`, driven by the
  last completion's input tokens and the agent's `contextWindow` manifest field, with
  conservative family inference for claude/gpt-4o), a session timer, and client/backend
  versions (the client version is baked in at build time, so a stale cached UI is
  visible at a glance).

### Changed

- **The web UI is now real source files.** `src/channels/web-ui.ts` is generated by
  `scripts/build-web-ui.mjs` from `src/web/ui/` (index.html + styles.css + app.js +
  login.html) — no more 1,500-line TS template string, no backtick escaping rules; edit
  the plain files and run `npm run build:web-ui` (part of `npm run build`).


### Added

- **Agents can opt out of a prompt section entirely.** For `souls` / `personas` /
  `standards` / `operations`, an empty/omitted list still means "include all" and a
  named list still means "only those" — but `["none"]` now means "include nothing".
  This lets an orchestrator drop sections it doesn't need from every turn's prompt
  (e.g. `standards: ["none"]` on an assistant that never writes code), shrinking the
  fixed prompt prefix. ([#129])


### Added

- **Debug log captures the full input.** Each conversation-log record now includes
  `input` — the exact system prompt, every tool definition (built-in + MCP), and the
  replayed message history sent to the model that turn (image base64 elided). This is
  the empirical answer to "what was actually sent, and why is the prompt this big?" —
  the persistent, per-turn version of the `/tmp/dae-context` dump. ([#128])


### Added

- **Activity chrome survives reload / device-switch (web).** Tool rows and reasoning
  are now reconstructed when a conversation is loaded from history, not just while it
  streams live. `/history` returns structured blocks (text / thinking / tool, with each
  tool's resolved ✓/✗) for assistant turns, and the client rebuilds the inline flow.
  Previously, switching chats or opening the same conversation on another device showed
  only flattened text. ([#127])

### Fixed

- **Mobile: wide tables/code no longer overflow the viewport.** The message bubble
  lacked `min-width: 0`, so a wide table set its width past the screen edge until you
  navigated away and back. The bubble now clamps to `min(760px, 100%)` and shrinks
  properly, so wide content scrolls within the bubble instead. ([#127])


### Fixed

- **Skill-trigger instructions no longer pollute the conversation.** When a message
  matched a skill trigger, ingest inlined the entire skill body into the stored user
  message — so it showed up as your message on reload AND was re-sent to the model on
  every later turn in that session (context bloat + cost). The trigger preamble is now
  an *ephemeral* directive: only your actual text is persisted, and the skill
  instructions are injected into the model's view of the turn at runtime (never
  stored). ([#126])


### Fixed

- **Thinking no longer double-rendered (web).** On streaming channels, surfaced
  reasoning was shown twice — inline as it streamed AND again as trailing "💭"
  message bubbles (the buffered-channel path firing on top). Thinking is now returned
  separately from system notices, and the buffered "💭" messages are delivered only to
  channels that can't render inline (Telegram). Streaming channels show it inline only.

### Changed

- **Reasoning is a distinct, collapsible disclosure (web).** Thinking now renders as
  a muted, italic "💭 Thinking" block behind a header — visually unlike the reply, so
  it reads as the model's scratchpad rather than part of the answer. It's expanded
  while streaming and auto-collapses when the turn completes (one click to reopen).

- **Interleaved streaming blocks (web).** A streamed reply now renders as an ordered
  flow of blocks — text, reasoning, and tool-call rows appear in the order events
  actually occur (text → tool → text → tool → …), like Claude, instead of grouping
  all tool rows at the top and all text below. Each text run renders to markdown when
  the turn completes.

### Added

- **Turn timer + token count (web).** A Claude-style elapsed-time readout: a live
  "Xs" ticks from when you send until the reply completes, then freezes on the
  reply's footer. When the provider reports usage, the input/output token count is
  shown alongside it (e.g. `12.4s · ↑1.2k ↓340`). Timing is client-side; the token
  count rides on the existing kernel usage aggregation via the `turn_complete`
  event.

### Changed

- **Claude-style tool-call rows (web).** Tool use now renders as a collapsible row —
  `Ran <tool>` with a one-line summary of the primary argument (e.g. the fetched URL)
  and a running → ✓/✗ state — that expands to the full input. Replaces the bare tool
  pill, so you can see what each call did and when, in order. The `tool_use` event now
  carries the parsed input and `tool_result` resolves the row's state. The debug-log
  chip moved into the reply footer alongside the timer/token readout.

- **Smoother streaming render.** During a streamed reply the web UI now shows the
  raw text as it types — prose in the normal proportional font, with only code
  fences and table rows in monospace (so they stay aligned) — and renders full
  markdown once, when the turn completes. This replaces re-parsing partial markdown
  on every token, removing the vertical jitter and the mid-stream table flicker;
  with a reserved scrollbar gutter it also removes the sideways "wobble" on long
  outputs. The reply types out, then snaps to formatted markdown when done.

- **Sleeker web UI.** Assistant replies are now borderless (plain text, like
  ChatGPT/Claude) rather than boxed bubbles — only the user's own messages keep a
  bubble — with tighter, more even spacing. The header, sidebar, and composer
  recede behind hairline borders and a page-matched background, with softer
  controls and a rounded composer. Tool calls and the debug-log pointer render as
  distinct muted "activity chips" (a dot + monospace label), and model reasoning as
  a quiet left-bordered inset — all clearly subordinate to the reply itself.
- **Debug-log pointer is now activity chrome, not a message.** Instead of a
  separate chat bubble, it surfaces as a "debug log" chip on the reply (click to
  copy the path), the same treatment as tool/reasoning markers. It's therefore no
  longer included in copied transcripts and is not sent to buffered channels
  (Telegram). Delivered via a new `debug_log` turn event over the streaming path.

### Added

- **Live response streaming (phases 0–2).** Replies now stream token-by-token to
  the web UI and CLI. Providers expose a `stream()` method emitting incremental
  events (text, reasoning, tool-call args) plus a terminal assembled result; the
  Anthropic and OpenAI-compatible adapters implement it (the latter capturing
  reasoning from a `reasoning_content` delta field or inline `<think>` tags via a
  chunk-aware splitter). The kernel consumes the stream and emits structured
  `TurnEvent`s (turn boundaries, deltas, tool_use → tool_running → tool_result). The
  warm agent worker streams these back to the supervisor as NDJSON over its `/turn`
  response, so streaming works on the deployed (`persistentAgent`) path, not just
  in-process. The **web UI renders replies incrementally** (token deltas, a dim
  reasoning block, tool markers) over SSE, and the **CLI** renders them to the
  terminal. Streaming is additive: the buffered `complete()` path is unchanged, and
  channels that don't implement a stream sink stay buffered — **Telegram
  deliberately so** (edit-throttled streaming is a poor UX). A global
  `streaming.enabled` toggle (default on) is the escape hatch if a gateway mishandles
  streaming. Subagent turns (ephemeral containers) remain buffered.

- **Conversation debug log.** Opt-in per-turn trace for answering "did the agent
  actually run that tool, or fabricate the result?". With
  `debug.conversationLog.enabled: true`, every turn (top-level and subagent) appends a
  structured JSONL record — the complete exchange the kernel produced (every `tool_use`
  with its args, every `tool_result` with its output), plus aggregate token usage and the
  stop reason — to `<path>/<sessionId>__<date>.jsonl`. A claim with no preceding
  `tool_use` in the trace was a hallucination, not a real check. Files older than
  `retentionDays` (default 5) are pruned on each write. The log path for the top-level turn
  is surfaced to the operator as a short message **after** the reply. Off by default; meant
  for single-operator deployments (it writes full prompts and tool I/O to disk). In docker,
  point `debug.conversationLog.path` at `/data/debug-logs` so it lands in the mounted volume.

- **Model thinking surfaced as messages.** Agents can now request and show their reasoning.
  `thinking.enabled` requests Anthropic extended thinking (`thinking.budgetTokens`);
  reasoning from OpenAI-compatible backends is captured regardless of this flag (a
  `reasoning_content` field or inline `<think>` tags). With `thinking.surface: true`, each
  turn's reasoning bubbles up to the user as its own message(s) before the reply — the
  persona "thinking out loud". Thinking blocks are preserved with their Anthropic signature
  so they round-trip correctly through tool-use loops, and stripped from history when
  thinking is off. Reasoning is always recorded in the conversation debug log when that's
  enabled. Per-turn token usage is now aggregated and returned by the kernel.

- **Skill triggers: deterministic phrase → skill routing.** Skills can declare
  plain trigger phrases in SKILL.md frontmatter — e.g.
  `triggers: ["good night", "go dark"]`. When a message contains one
  (whole-word, case/punctuation-insensitive), ingest prepends a preamble
  carrying the matched skill's instructions inline — same shape as
  slash-command expansion — so the agent acts in one model call instead of
  spending a `load_skill` round-trip on a file that's known ahead of time.
  The skill-menu description alone is advisory — the model could answer a
  phrase like "good night" conversationally without reaching for the skill. Triggers
  route; they don't bypass: the model still runs the turn, so mixed messages
  ("good night — also, is the back door locked?") keep working. Slash-command
  input skips trigger detection. ([#113])

### Changed

- **Memory: setup-agnostic model defaults + `SPARK_URL` renamed to
  `OPENAI_BASE_URL`.** The Graphiti memory config previously baked in
  setup-specific model aliases (`artemis` for extraction, `embeddings` for
  embeddings) as the defaults, so a fresh install pointing at any other
  OpenAI-compatible endpoint silently failed extraction until the names were
  discovered and overridden. `dae install` now **asks** for the extraction
  model name, embeddings model name, and embeddings dimension (pre-filled
  with conventional OpenAI ids `gpt-4o-mini` / `text-embedding-3-small` /
  `1536`) and writes them to the compose `.env`. The endpoint URL var is
  renamed `SPARK_URL` → `OPENAI_BASE_URL`; set `OPENAI_BASE_URL` and the
  three `GRAPHITI_*` model keys in your compose `.env`. ([#109])

- **Webchat: the Main session is hidden; every web conversation is
  deletable.** The default/"Main" session is the cross-channel thread
  (Telegram etc.) and can't safely be dropped (it's resolved as the
  oldest session for a user+agent — deleting the row would silently
  promote another web conversation to be the default other channels
  write into). Instead of showing it with a special non-deletable
  status, the web sidebar no longer lists it at all: web shows only its
  own isolated conversations, all deletable, opening the most recent one
  on load (creating the first if none exist). At the API level,
  `DELETE /conversations` on the default session clears its history and
  returns `{ ok: true, cleared: true }` instead of the previous 403.
  ([#112])

### Added

- **Persistent auto-compaction.** The kernel's reactive on-overflow
  summarise/drop only shrank what was sent within a single call — every
  later turn reloaded the full history and paid the overflow round-trip
  (and summary cost) again. Now, after a turn that had to shrink its
  context, the supervisor summarises the full conversation and persists
  it as a compaction marker in the session; subsequent turns replay only
  the marker (the summary) plus everything after it. The user is told
  when it happens (the existing live notice), and the web UI renders the
  marker inline as a muted system notice in history. Stored history is
  never deleted — the marker only changes where the model's context
  starts. ([#112])

- **Built-in `/compact` command.** Sending `/compact` on any channel
  triggers the same persistent compaction manually: the supervisor
  summarises the conversation so far (optionally steered, e.g.
  `/compact focus on the deploy plan`), persists the marker, and replies
  with a confirmation — the agent itself never runs. Listed in the
  agent's system-prompt command menu and the web UI's autocomplete. A
  brain-defined `commands/compact.md` takes precedence over the
  built-in. ([#112])

- **Webchat: slash-command autocomplete.** New `GET /commands` endpoint
  lists the slash-commands the default agent accepts (name, description,
  aliases — resolved from the brain's `commands/` directory per the
  agent's `commands:` manifest). The chat input shows a menu of matches
  while the draft is a lone `/word`: ↑/↓ to choose, Tab/Enter to
  complete, Esc to dismiss, click to fill. ([#112])

- **Webchat: Copy button on code blocks.** Every `<pre><code>` block in
  an assistant reply now has a small "Copy" button in the top-right corner.
  Click → text goes to the clipboard, button briefly reads "Copied!" then
  resets. Inline `` `code` `` stays as-is (too small for a button to be
  worth the noise). Wired via event delegation on `#log` so it works for
  bulk-loaded history and live SSE messages alike. Falls back to a hidden
  `<textarea>` + `execCommand("copy")` on plain-HTTP origins where
  `navigator.clipboard` isn't available. ([#89])

- **Webchat: user messages render as Markdown.** Previously the user
  branch in `addMsg` HTML-escaped and wrapped in a `<p>`, so typed
  markdown surfaced as literal asterisks / hashes / backticks. Both
  message roles now share the same `md()` render path — user-typed
  code fences (with the Copy button), tables, lists, links, and
  emphasis all format the same way assistant replies do. The role
  still controls the bubble's blue/dark styling via the `.msg.user` /
  `.msg.assistant` class, not the content. Server-side persisted text
  is unchanged — this is purely a client-side display change. ([#90])

### Fixed

- **Deterministic message replay order.** `tail()` ordered messages by
  `created_at`, whose millisecond resolution ties when a turn persists
  several rows back-to-back (tool loops, the reply, a compaction marker)
  — leaving their replay order to SQLite's whim. Now ordered by `rowid`
  (insertion order). ([#112])

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
[#90]: https://github.com/inline-studio/daedalus/pull/90
[#109]: https://github.com/inline-studio/daedalus/pull/109
[#112]: https://github.com/inline-studio/daedalus/pull/112
[#113]: https://github.com/inline-studio/daedalus/pull/113
