# WS6/WS7 — Client surfaces: one core, many instances

Follows the July 2026 roadmap (2026-07-roadmap.md, delivered in PR #133). This plan
covers the client-surface work that the delivered platform exposed as the next gap.

## The model

**One core.** Brain (agents/skills/personas/standards), memory (Graphiti), sessions,
scheduler, channels — a single daedalus deployment (casa) is the source of truth. A
"local core" is the same stack run on a laptop and addressed as `localhost`; it is a
*location*, not a mode. Explicit anti-goal: never sync brain/memory between two cores —
fragmentation is the problem the single core exists to solve.

**Many surfaces.** Web UI, desktop app, terminal client, Telegram — all clients of the
core's channel API, sharing sessions and memory. Desktop and terminal are the two
surfaces that can also *execute*.

**Three execution targets** — the concept that unifies "run this on my machine" vs
"run this in a container on the server":

| Target | Meaning | Status |
|---|---|---|
| `server-host` | warm worker / agent container without an image | shipped |
| `docker:<image>` | per-agent container via `container.image:` frontmatter | shipped |
| `executor` | the connected client machine, permission-gated | shipped (WS5), all-or-nothing per user |

Placement is decided by: agent frontmatter (default), a per-conversation client toggle
(WS6e), and — for sub-agents — a new `execution: executor` frontmatter field (WS7).

**Deliberate cuts** (agreed 2026-07-03):

- No client-side control of the server's host/docker dispatcher — that's a deployment
  property. Clients display it (status bar), never set it.
- No "local vs remote core" mode in clients — just a URL.
- No permission gating for server-side (containerised) execution — the container is the
  permission boundary. The confirm/allowlist/free-rein gate applies exactly where blast
  radius is the user's machine: the executor.

---

## WS6a — Stop / abort a turn

**Goal:** stop an in-flight turn from any streaming surface (premature enter, wrong
direction, runaway loop) — like Claude desktop's stop button.

- **Server:** an in-flight registry in serve keyed by conversation
  (`conversationId → abort()`). New `POST /abort {conversationId}` on the web channel
  (ownership-checked, threaded from serve like the status provider). Abort per dispatch
  mode:
  - in-process — an `AbortController`; the kernel already accepts a signal
    (`runWithMessages(messages, signal, …)`), it's just never wired from a channel. Add
    a signal check between tool executions so an abort lands mid-loop, not only at the
    next model call.
  - warm worker — a `POST /abort {sessionId}` endpoint on the worker; the worker keeps
    its own per-turn AbortControllers. The supervisor's persistent dispatcher forwards.
  - container — the dispatcher records the container name per dispatch and
    `docker rm -f`s it.
- **Semantics:** partial streamed output stays visible; nothing further is persisted
  for that turn; the surface shows a quiet "⏹ stopped" notice (an abort is not an
  error — serve distinguishes AbortError from real failures).
- **Surfaces:** web UI + desktop — the Send button becomes **Stop** while a turn
  streams. Terminal client — Esc (WS6b's TUI owns the keybinding; the interim
  `dae remote` gets a `/stop` command).
- **Test:** smoke with a scripted slow provider — abort mid-turn, assert the turn ends,
  nothing persists after the marker, and a second turn runs cleanly.

Estimate: 4–5 days.

## WS6b — `dae` terminal interface (the real CLI)

**Goal:** not a single command but an *interface* — the Claude Code / Hermes-CLI shape:
a persistent terminal app with streaming output, a status line, slash commands, and
keybindings. Replaces the bare readline REPL of `dae remote`.

- **Layout** (hand-rolled ANSI on `node:readline` keypress events — no new runtime
  dependencies, matching the zero-dep web UI; `--plain` falls back to the current
  line-based mode for pipes/CI):
  - scrollback: streamed reply text, dim tool lines, sub-agent `[cypher] …` lines,
    reply footer (elapsed · tokens)
  - persistent bottom **status line**: core URL · gateway state · agent · context
    readout (from `turn_done`) · executor state (`local exec: on/off/ask`) · session
    timer
  - input line with prompt, history (persisted), multi-line via trailing `\`
- **Slash commands:** `/stop`, `/new`, `/sessions` (pick/switch), `/agents`, `/crons`,
  `/local on|off` (per-conversation execution toggle), `/allow <prefix>`, `/yolo`,
  `/status`, `/help`, `/quit` — plus passthrough of server-side commands (`/compact`,
  brain commands) which already expand server-side.
- **Keybindings:** Esc = stop the current turn; Ctrl-C twice = quit.
- **Profile + wizard:** first run with no args prompts (core URL → auth (token or
  user/password) → workspace → execution default → approval mode) and persists to
  `~/.daedalus/remote.json`; thereafter `dae remote` (alias `dae chat`?) just connects.
  Flags override the profile.
- **Executor:** unchanged from WS5 (confirm gate, allowlist, denylist, audit log,
  headless refusal) — rendered through the TUI (inline y/N/a prompt on the input line)
  instead of raw readline.
- **Default lean:** the terminal client defaults to local execution ON (that is its
  point); `/local off` per conversation.

Estimate: ~2 weeks (the TUI layer is most of it; everything behind it exists).

## WS6c — Desktop: executor, wizard, permissions, settings

**Goal:** the desktop app becomes a first-class executor with a real first-run wizard —
it will never run `dae install`, so it owns its own onboarding.

- **Embedded executor** in the Electron main process — reuses the WS5 client logic
  (SSE stream → child_process → result POST) with the same allowlist/denylist/audit
  files. In login mode the executor is keyed by user, so one executor serves desktop +
  web + CLI sessions at once (and vice versa: a running `dae remote` already serves
  desktop chats).
- **Wizard** (first run, replaces the bare URL page): core URL → login → "Allow this
  Mac to run commands the agent asks for?" → workspace picker (native dialog) →
  approval mode: **ask** (default) / allowlist / free rein.
- **Permission prompts** as native dialogs (command shown, Allow / Always allow prefix /
  Deny), matching the CLI gate's semantics exactly — same files, same denylist.
- **Settings window:** core URL, executor on/off, workspace, approval mode, default
  execution per new conversation, view/edit the allowlist, open the audit log.
- **Stop button** comes free via WS6a (it's the web UI).

Estimate: ~1.5 weeks.

## WS6d — Agents & schedules viewers

- **Server:** `GET /agents` (name, description, provider/model, tools, skills,
  container image, subagents — read fresh from the brain) and `GET /schedules`
  (static YAML schedules + live `scheduled_messages` rows with next-fire). Both behind
  the existing web auth; counts in `/status` stay as the cheap summary.
- **Desktop/web:** sidebar sections (the reference layout's "Skills & Tools" area):
  Agents list with model/tools detail, Cron list with next fire + enabled state.
- **CLI:** `/agents`, `/crons` render the same endpoints as tables.

Estimate: 3–4 days.

## WS6e — Per-conversation execution toggle

- `POST /messages` gains `execution: "local" | "server"` (only honoured when the
  feature is enabled and the user's executor is connected; absent = client default).
- serve threads it into the existing `remoteExec` decision.
- Web/desktop: a small toggle in the composer (defaulted from settings). CLI:
  `/local on|off`, default on.

Estimate: 1–2 days.

## WS7 — Placement + environment awareness

- **`execution: executor` agent frontmatter** — a sub-agent that must run on the
  user's machine (host-only tooling). When spawned within a turn that has a connected
  executor, its runtime is RemoteRuntime (thread `remoteExec` into the spawn dispatch
  conditionally); without an executor it fails fast with a clear message. Sub-agents
  without the field keep today's server-side behaviour.
- **Environment advertisement** — the executor registers platform/arch/hostname along
  with the workspace; the turn injects one context line ("executing on Scott-MBA,
  darwin/arm64, workspace ~/code/x") so the model stops assuming the container
  toolchain and probes with `command -v` where it matters.
- **Capability probe (optional, later)** — executor reports which of the
  skills-required binaries resolve, so the skill menu can flag unavailable skills for
  remote turns.

Estimate: ~1 week.

## Sequencing

| Phase | Depends on | Estimate |
|---|---|---|
| WS6a stop/abort | — | 4–5 d |
| WS6d viewers | — (parallel) | 3–4 d |
| WS6e execution toggle | — (parallel) | 1–2 d |
| WS6b terminal interface | 6a (Esc=stop), 6d/6e (commands) | ~2 wk |
| WS6c desktop executor + wizard | 6a, 6e | ~1.5 wk |
| WS7 placement + env | 6e | ~1 wk |

All branches follow the standard process: full local validation (mac, colima docker)
before push; casa is user-acceptance only.
