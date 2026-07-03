# Feature roadmap — July 2026

Four workstreams, ordered by dependency and leverage:

1. **Live sub-agent view** — small, verified scope; every later surface benefits.
2. **Self-learning + automatic skill generation** (Hermes-style).
3. **Web UI v2 + status/metrics APIs** — the Hermes-style interface, shared by browser and desktop.
4. **Desktop app (Electron shell)** — wraps Web UI v2 with native integration.
5. **Remote CLI** (remote brain, local execution) — largest design surface, independent of the others.

Each workstream ships as its own `feature/*` branch + PR. Estimates are focused
engineering time, excluding review cycles.

---

## Workstream 1 — Live sub-agent view

**Goal:** when the orchestrator spawns a subagent, the user sees what it is doing in
real time (turns, tool calls, streaming text) in both the CLI and web surfaces —
instead of the current opaque `spawn_subagent` call that only returns a final result.

### Current state (verified)

- The kernel already emits fine-grained `TurnEvent`s — `turn_start`, `text_delta`,
  `thinking_delta`, `tool_use_start`, `tool_running`, `tool_result`, `turn_complete`
  (`src/types.ts:136-156`) — and the web channel streams them over SSE.
- Gap A: `spawn_subagent` calls `ctx.dispatcher.dispatch({...})` **without** passing
  `onEvent` (`src/kernel/orchestrator.ts:106`), even though `DispatchArgs.onEvent`
  exists (`src/dispatch/base.ts:52`) and the in-process + persistent dispatchers
  already forward it.
- Gap B: ephemeral subagent containers don't stream at all — `ContainerAgentDispatcher`
  buffers stdout and parses one sentinel-framed final `DispatchResult`
  (`src/dispatch/container.ts:296`).

### Design

**Event envelope.** Add an optional origin field to every `TurnEvent` rather than new
event types, so existing consumers keep working:

```ts
// src/types.ts
interface TurnEventOrigin {
  agent: string;        // "cypher"
  depth: number;        // 1 for a direct subagent, 2 for its subagent, …
  spawnId: string;      // unique per spawn_subagent call — groups one subagent run
}
type TurnEvent = { origin?: TurnEventOrigin } & (… existing union …)
```

Plus two new lifecycle events so surfaces can open/close a panel deterministically:
`subagent_start { origin, prompt }` and `subagent_end { origin, status }`.

**Plumbing.**

1. `orchestrator.ts` — in the `spawn_subagent` handler, generate a `spawnId`, emit
   `subagent_start`, pass `onEvent: (ev) => parentSink({ ...ev, origin })` into
   `dispatch()`, emit `subagent_end` when the result returns. Nested spawns compose
   for free: each hop re-wraps with `depth + 1`.
2. `dae agent-turn` (ephemeral container path) — when a new env flag
   `DAE_EVENT_STREAM=ndjson` is set, write each `TurnEvent` to stdout as a
   sentinel-framed NDJSON line (distinct frame from the final `DispatchResult`
   sentinel, same bottom-up-scan robustness).
3. `ContainerAgentDispatcher` — switch from buffered exec to streaming exec (execa
   already supports this), parse event lines as they arrive, forward to
   `args.onEvent`; final result parsing unchanged. Mark the dispatcher as
   `supportsEventStreaming`.
4. Warm-worker path (`src/dispatch/persistent.ts`) already streams NDJSON — only the
   `origin` pass-through is new.

**Surfaces.**

- **Web channel** (`src/channels/web.ts`): forward origin-tagged events on the SSE
  stream (new `subagent` SSE event kind carrying the raw TurnEvent).
- **Web UI** (`src/channels/web-ui.ts`): render a collapsible "⚙ cypher — working…"
  panel inside the assistant bubble per `spawnId`; show live tool-call lines and
  optional streamed text; collapse to a one-line summary on `subagent_end`. The UI
  already renders live tool chips for the top-level agent, so this is mostly reuse.
- **CLI channel** (`src/channels/cli.ts`): prefix lines —
  `[cypher] running: npm test …`, `[cypher] done (42s)`. Gate verbosity behind a
  `channels.cli.subagentEvents: summary | full | off` config (default `summary`:
  spawn, tool commands, end).

**Config.** `runtime.subagentEventStream: boolean` (default `true`), plus the CLI
verbosity knob above.

### Testing

- `scripts/smoke-subagent-events.mjs`: in-process dispatcher, orchestrator + one
  subagent, assert the parent sink receives origin-tagged events bracketed by
  `subagent_start`/`subagent_end`.
- Extend `scripts/smoke-web-ui.mjs`: SSE stream carries `subagent` events; panel
  markup renders.
- Docker-mode manual pass on the mac (colima) per the standard local-first process.

**Estimate:** 4–6 days. **Risks:** stdout framing collisions in noisy containers
(mitigated by the existing sentinel approach); event volume on chatty subagents
(mitigate: drop `text_delta`/`thinking_delta` at depth ≥ 1 unless `full`).

---

## Workstream 2 — Self-learning + automatic skill generation

**Goal:** the agent improves itself from experience — after substantial tasks it saves
or patches skills; durable facts keep flowing to memory; stale skills age out — the
Hermes-agent loop (github.com/NousResearch/hermes-agent, MIT), adapted to daedalus.

### What daedalus already has

- Post-turn **memory** curation: `autoSaveMemory` (`src/memory/auto-save.ts`), fired
  from `src/kernel/agent-turn.ts:461` — the exact fire-and-forget post-turn pattern
  Hermes uses, currently memory-only.
- Skills framework with progressive disclosure (`src/brain/skills.ts`,
  `src/tools/load-skill.ts`) — same shape as Hermes' skills index + `skill_view`.
- Agent-writable brain behind `brain.writable: true` (`src/tools/file.ts:12`).
- Scheduler for periodic jobs (`src/scheduler/cron.ts`).

### What gets built

**2.1 `skill_manage` tool** (`src/tools/skill-manage.ts`)

Actions: `create`, `patch`, `append_reference`, `archive`, `list`. All writes:

- validate against the existing skill manifest schema (`src/config/schema.ts:523`);
- refuse when `brain.writable` is false;
- when `skills.learning.writeApproval: true`, write to
  `<brain>/skills/.pending/<name>/` instead of the live directory, for human review
  (`/skills approve|reject` slash-commands in `brain/commands/`);
- `archive` moves to `<brain>/skills/.archive/` — **never deletes**.

Available only to agents whose manifest lists it; intended for the orchestrator and
the review pass, not leaf subagents.

**2.2 Skill-review pass** (`src/brain/skill-review.ts`)

Mirror of `autoSaveMemory`, run alongside it after top-level turns:

- Replays the compacted turn transcript (reuse `renderTurnTranscript`) against a
  review prompt with **only** `skill_manage` callable.
- Review prompt ports Hermes' load-bearing rules verbatim in spirit:
  - prefer patching an existing skill over creating one; class-level umbrella skills,
    not one-session-one-skill entries;
  - user corrections of style/workflow are first-class skill signals;
  - never persist environment-transient failures or negative tool claims;
  - a skill that proved wrong this session gets patched *now*.
- **Trigger policy** (avoid an LLM call after every trivial turn): run when the turn
  used ≥ N tool calls (default 5), or a skill was loaded this turn, or the
  tool-iteration nudge counter (below) crossed its threshold. Config:
  `skills.learning.{enabled, model, minToolCalls, nudgeInterval}` — same shape as
  `memory.autoSave`.
- Same model as the agent by default → warm prefix cache → cheap; `model` override
  for routing to a small aux model (which then gets a digest, not the full replay).

**2.3 Nudge counters**

Per-session counters (sessions sqlite): tool iterations since last `skill_manage`
use. Crossing the threshold arms the next review pass; it never interrupts the live
turn. Reset when `skill_manage` runs.

**2.4 Prompt guidance**

A `Skill upkeep` block appended by the composer (`src/brain/composer.ts`) whenever an
agent has `skill_manage`: the "after a complex task, save the approach; when a loaded
skill is wrong, patch it immediately" contract, and the memory/skill split (facts →
memory, procedures → skills). Built-in, not a brain file — it's coupled to the tool's
existence.

**2.5 Usage tracking + curator**

- `load_skill` records `(skill, ts)` into a `skill_usage` table (sessions sqlite).
- Curator job — a built-in scheduled task (default cron `0 4 * * 0`, config
  `skills.learning.curator`): deterministic transitions on agent-created skills only
  — unused > 30 days → `stale` (frontmatter flag, demoted in the menu),
  > 90 days → moved to `.archive/`. Pinned skills (`pinned: true` frontmatter) are
  exempt. No LLM in the loop by default; an opt-in consolidation pass (merge
  overlapping skills into umbrellas) can come later.
- Brain-is-a-git-repo synergy: when the brain has a `.git`, the review pass commits
  its writes (`skill(<name>): <action>`) so every learned change is diffable and
  revertible.

### Testing

- Unit: `skill_manage` validation, pending/approve flow, archive semantics.
- `scripts/smoke-skill-learning.mjs`: scripted turn with a fake provider → review
  pass fires → SKILL.md lands (or lands in `.pending/` with approval on).
- Curator: fixture skills with backdated usage rows → transitions assert.

**Estimate:** 8–10 days. **Risks:** low-quality generated skills polluting the brain
(mitigations: approval mode default **on** initially, git-tracked writes, archive-only
curator); review-pass cost (mitigated by trigger policy + cache-warm fork).

---

## Workstream 3 — Web UI v2 + status APIs (Hermes-style interface)

**Goal:** bring the web surface to the Hermes bar: session sidebar, pinned chats,
search, live thinking/tool blocks (exists), and a **status bar** — token usage,
context %, session timer, gateway/connection state, agent count, cron count, client +
backend versions. Dark theme, accent color, code-chip styling per the reference
screenshot. This UI is what the desktop app (WS4) wraps, so it lands first.

### 3.1 Server: status + metrics APIs (`src/channels/web.ts`)

New authenticated endpoints on the web channel:

- `GET /status` — snapshot + SSE-pushed updates (`status` event kind):
  - `version` (backend), `channels: [{name, state}]` (Telegram/WhatsApp connected?),
    `agents: {count, names}` (from brain), `schedules: {static, dynamic}` counts
    (loader + `scheduled_messages` table), `dispatcher`, `memory: {backend, ready}`.
- Per-conversation context/token readout:
  - `turn_complete.usage` already reaches the UI per reply
    (`src/channels/web.ts:284`); add a cumulative
    `context: {inputTokens, window, percent}` to the same SSE payload.
  - Context-window size: new `contextWindow` field on the agent manifest
    (`src/config/schema.ts`), with defaults for known model families in a small
    static map (`src/providers/model-info.ts`). Percent = last turn's
    `inputTokens / window` — the same approximation the screenshot shows.
- Session timer stays client-side (it already exists in the reply footer).

### 3.2 Frontend restructure

`web-ui.ts` is a 1,498-line TS template string; v2 outgrows that. Restructure without
adding runtime dependencies:

- Split into real files under `src/web/ui/` (`index.html`, `app.js`, `styles.css`,
  components) — plain ES modules, no framework.
- Build step in `scripts/` (esbuild as a devDependency, same pattern as
  `scripts/vendor-web-libs.mjs`) bundles them into the served single document at
  `npm run build`. Runtime stays zero-dependency and fully self-contained.

### 3.3 Layout (per the Hermes reference)

- **Left sidebar:** New session, sections (Skills & Tools, Messaging, Artifacts —
  Artifacts = the attachment catalogue, which already exists server-side), session
  search (new `GET /conversations?q=` against titles + message FTS), pinned sessions
  (new `pinned` column on `sessions`), session list with unread dots, channel badge
  (bottom: Telegram/… indicators from `/status`).
- **Main pane:** existing chat, restyled — thinking blocks as quiet collapsed
  sections, tool runs as one-line chips (`Ran <cmd> + N commands`), inline code
  chips, user bubbles right-aligned cards. Sub-agent panels from WS1 slot in here.
- **Status bar (bottom):** left — gateway state (SSE connected/reconnecting), agent
  count, cron count; right — `65.0k/256.0k [▮▮▯…] 25%` context readout, session
  timer, client + backend versions.
- **Theming:** CSS custom properties (dark default matching the screenshot's
  near-black + teal accent), light theme via `prefers-color-scheme`.

### Testing

Extend `scripts/smoke-web-ui.mjs` for `/status`, search, pinning, and the SSE status
events; visual pass on desktop + mobile widths.

**Estimate:** 2–3 weeks (APIs ~4 days, restructure ~3 days, layout/styling ~5–7 days,
search/pinning ~3 days). **Risks:** scope creep on polish — timebox the styling pass;
FTS on messages may need a migration (sqlite FTS5 table, additive).

---

## Workstream 4 — Desktop app (Electron shell)

**Goal:** a native desktop app that looks and feels like the reference screenshot —
which, after WS3, is "Web UI v2 in a frameless window" plus native integration. The
supervisor stays on the server; the app is a client. No daedalus core changes.

### Design

New top-level `apps/desktop/` (own package.json; not shipped in the npm package):

- **Shell:** Electron + electron-builder. `BrowserWindow` with `hiddenInset` title
  bar (traffic lights over the sidebar, as in the screenshot), `preload.js` with a
  minimal `contextBridge` API; `nodeIntegration` off, `contextIsolation` on.
- **Server connection:** first-run dialog for server URL + token (login mode reuses
  the existing cookie flow); persisted in `app.getPath('userData')`. Multiple server
  profiles later.
- **Native integration:**
  - notifications on `notice`/reply SSE events when the window is unfocused —
    closes the "web channel doesn't push" gap from the scheduler work;
  - dock/taskbar badge for unread replies;
  - tray icon with gateway state + quick "New session";
  - global hotkey to summon the window; auto-launch at login (opt-in).
- **Renderer → shell hooks:** Web UI v2 detects `window.daedalusDesktop` (exposed by
  preload) and routes notifications/badges through it instead of the Web
  Notifications API.
- **Packaging:** electron-builder → signed DMG (mac first; Linux AppImage second);
  auto-update via electron-updater + GitHub releases feed.

### Testing

Manual acceptance matrix (connect, reconnect after server restart, notifications,
badge, sleep/wake SSE recovery) + a smoke script driving the packaged app with
Playwright's Electron support.

**Estimate:** ~1 week after WS3 (shell + preload 2 days, native integration 2 days,
packaging/signing/auto-update 2–3 days). **Risks:** mac code-signing/notarization
logistics (Apple Developer account needed); SSE reconnection after sleep needs
explicit handling (the UI already tags events with `id:` for `Last-Event-ID` replay).

---

## Workstream 5 — Remote CLI (remote brain, local execution)

**Goal:** `dae remote` on the laptop connects to the server-hosted supervisor; the
LLM loop, sessions, and memory stay on the server; `bash`/file tools execute on the
laptop. Outbound-only from the client — no ports opened, no NAT games.

### Design

**Transport.** One outbound WebSocket from client → server (`/rpc` on the web
channel's HTTP server, upgrade handled alongside existing routes). Multiplexed,
JSON-framed:

- server → client: `event` (TurnEvents for rendering), `exec_request { id, cmd,
  opts }`, `file_request { id, op, path, … }`
- client → server: `message` (user input), `exec_result { id, stdout, stderr, code }`
  / chunked `exec_output` for streaming, `file_result`
- auth: bearer token on upgrade (reuse `channels.web.token` / login session);
  heartbeat ping/pong; reconnect with session resume.

**Server side.**

- `RemoteRuntime implements Runtime` (`src/runtime/remote.ts`) — `exec()` resolves
  the connected client for the session's user and awaits the round-trip, with
  timeout + disconnect → clean tool error ("local executor offline").
- Client registry keyed by `userId` on the web channel; the dispatcher passes a
  runtime override so an agent turn serving a remote-CLI session gets
  `RemoteRuntime` instead of Host/DockerRuntime. This is the one kernel touch:
  `buildRuntime` (`src/runtime/factory.ts`) learns a third variant selected per-turn.
- **File tools decision:** `read/write/edit/glob/grep` currently hit the container
  fs directly (`src/tools/file.ts`). For the MVP they route through the same
  `file_request` RPC when `RemoteRuntime` is active — the Runtime interface grows
  optional `readFile/writeFile/list` members with container-local fallbacks.
  `/brain` and `/shared` remain server-side concepts; local file ops are rooted in a
  client-declared workspace dir.

**Client side** (`src/cli/remote.ts`, wired as `dae remote <url>`).

- REPL matching the existing CLI channel UX + WS1's subagent prefixes.
- **Safety gate:** every `exec_request` is confirmed interactively by default
  (`y/N`, with the command shown), with `--yolo` to disable, a persisted allowlist
  ("always allow `git status`"), and a denylist that never auto-approves
  (`rm -rf`, `sudo`, …). Local execution runs as the invoking user with
  cwd = declared workspace.

### Security notes (must hold before merge)

- Remote brain ⇒ arbitrary shell on the laptop: token-authenticated upgrade, TLS via
  the fronting proxy (same rule as the web channel), confirm-by-default, per-session
  scoping (a client only serves exec for its own user's sessions), and an audit log
  of every executed command (`~/.daedalus/remote-exec.log`).

### Testing

`scripts/smoke-remote-cli.mjs` — in-process server + scripted client over a real
WebSocket: exec round-trip, streaming output, timeout, disconnect mid-exec,
allowlist persistence. Manual pass mac-client → casa-server.

**Estimate:** 2–3 weeks (protocol + registry ~4 days, RemoteRuntime + file routing
~4 days, client REPL + safety UX ~4 days, hardening + smoke ~3 days). **Risks:**
long-running commands over flaky links (chunked streaming + resume covers it);
file-tool semantics divergence (kept minimal by rooting everything in the declared
workspace).

---

## Sequencing & branches

| # | Branch | Depends on | Estimate |
|---|--------|-----------|----------|
| 1 | `feature/subagent-live-view` | — | 4–6 d |
| 2 | `feature/skill-learning` | — (parallel with 1) | 8–10 d |
| 3 | `feature/web-ui-v2` | 1 (renders subagent panels) | 2–3 wk |
| 4 | `feature/desktop-app` | 3 | ~1 wk |
| 5 | `feature/remote-cli` | 1 (event streaming reuse) | 2–3 wk |

Every branch follows the standard process: full local validation on the mac (colima)
as a fresh user before push; casa is user-acceptance only.
