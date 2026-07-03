# Channels

A **channel** is an inbound/outbound surface — Telegram, Web, CLI, WhatsApp. They are
**not groups**: every channel publishes into the same per-user session pool, so a user
who reaches you on Telegram and on Web shares **one** conversation history. Each channel
has a `defaultAgent` (who handles its messages unless a message is addressed to another
agent).

## Why Telegram is the primary channel

- **Separate bot comms.** You talk to a dedicated bot created via `@BotFather`, not your
  personal account. It's its own identity with its own token — isolated, revocable, and
  safe to run unattended. Daedalus uses **long-polling** (`getUpdates`), so there's no
  inbound webhook, no public port, no TLS termination to manage — it works from behind a
  home NAT/firewall out of the box.
- **Rich attachments, both directions.** Telegram natively carries photos, voice notes,
  and documents — inbound *and* outbound. That makes it the natural surface for an agent
  that browses (screenshots), generates files (PDFs, exports), or receives them.

Set it up with `dae install` (it asks for the BotFather token) — see [install.md](./install.md).

## Inbound attachments

When a user sends media, the Telegram channel fetches the bytes and normalises them:

- **Photos** → image parts the model can see.
- **Voice notes** → transcribed to text (when a Whisper backend is configured) and
  attached alongside the audio.
- **Documents** → stored attachments the agent can read via the `read_attachment` tool.

All attachments are content-addressable in the store on the shared `/data` volume.

### Re-referencing earlier uploads (the attachment catalogue)

Because the store is content-addressable, an uploaded file's bytes live on `/data`
indefinitely — but the agent only *knows* a file exists when the inbound message carries its
ref. Once that scrolls out of context, or in a brand-new conversation, the file becomes
unreachable even though it's still on disk.

The **attachment catalogue** fixes that. Every uploaded image/document is indexed (in the
sessions sqlite, keyed per **user**), so the agent can find files you shared earlier — in
this conversation or a previous one, on any channel — **without you re-uploading them**:

- **`find_attachment`** — search your prior uploads by filename or content keyword (empty
  query lists the most recent). Returns each match's `ref`, which the agent reads with
  `read_attachment`. Reach for it whenever you mention a document you "sent before".
- **`describe_attachment`** — lets the agent note a one-line content summary of a file it has
  read, so later `find_attachment` searches match by topic, not just filename.

Recall is **per-user**, so a PDF dropped in Telegram is findable from the web UI and vice
versa. Voice notes aren't catalogued (the transcript is the useful artifact, not the blob).
Only the top-level agent gets these tools — subagents bubble findings up through the
orchestrator. The catalogue is local-only (no egress) and **on by default**; disable it with
`sessions.attachmentIndex.enabled: false`.

## Outbound attachments (agent → user)

An agent can send a file back with the built-in **`attach_to_reply`** tool:

```
attach_to_reply({ path: "/shared/shot.png", caption: "in-line.studio homepage" })
```

How it flows:

1. The agent writes the file (e.g. a screenshot via `agent-browser`, or a generated PDF)
   under `/shared`, then calls `attach_to_reply` with the path.
2. The file is stored in the content-addressable attachment store (shared `/data`), and a
   ref is returned in the turn's result — refs, not bytes, so it crosses the dispatch hop
   cheaply.
3. The supervisor resolves the ref to bytes and hands them to the channel.
4. Telegram uploads it: `sendPhoto` for images, `sendDocument` otherwise; your text reply
   is sent as a normal message, with per-attachment captions.

Notes:

- Only the **top-level** agent (whose reply reaches the user) has `attach_to_reply`. When
  a **subagent** produces a file, it leaves it under `/shared` and the orchestrator
  attaches it. (Guide the orchestrator to do this in its agent body — see
  [agents.md](./agents.md).)
- Limit ~10 MB per file.
- The CLI channel notes attachments (`[attachment: shot.png …]`) since a terminal can't
  render them; the Web channel streams them base64 over SSE.

## Live sub-agent activity

Streaming surfaces (Web, CLI) show delegated work as it happens. When the orchestrator
calls `spawn_subagent`, the subagent's own turn events flow back tagged with an origin
(`path` — the agent chain, e.g. `["cypher"]` or `["cypher", "reviewer"]` for a nested
spawn — plus a `spawnId` grouping one delegation). This works across every dispatch
mode: per-turn agent containers stream sentinel-framed event lines on stdout, which the
container dispatcher forwards to the live sink.

- **Web** renders each spawn as a collapsible panel inline in the reply — the delegated
  prompt, then tool rows resolving ✓/✗ live, then a done / needs-input / failed state.
- **CLI** prints dim prefixed lines (`[cypher] ⚙ started: …`, `[cypher] tool: bash`,
  `[cypher] done`). Verbosity: `channels.cli.subagentEvents: summary` (default) /
  `full` (adds each subagent's final reply text) / `off`.
- Buffered channels (Telegram, WhatsApp) are unaffected — they still get only the
  orchestrator's final reply.

Subagent **text isn't** streamed to the user — the panel shows lifecycle + tool
activity; the subagent's findings reach the user through the orchestrator's own reply,
as before. Turn the streaming off globally with `runtime.subagentEventStream: false`.

## Stopping a turn

Streaming surfaces can abort an in-flight turn: the web/desktop **Send** button becomes
**Stop** while a reply streams (the remote CLI takes `/stop`). `POST /abort
{conversationId}` cancels the turn wherever it runs — AbortSignal in-process, a
forwarded abort on the warm worker, `docker rm -f` for per-turn containers. Partial
output stays visible, nothing further is persisted, and the conversation shows a quiet
"⏹ Stopped." rather than an error. Buffered channels (Telegram) have no stop control.

## Remote execution (`dae remote`)

The inverse of the usual deployment: the agent keeps running on the server — brain,
sessions, memory, LLM — but its **tools execute on your machine**. On the laptop:

```bash
dae remote https://chat.example.com --token <web token> --workspace ~/code/my-project
# login-auth servers:  dae remote https://chat.example.com --user scott
```

One process, two jobs: a chat REPL (stdin → the server's `/messages`; replies + live
turn events render from `/events`, sub-agent lines included), and the **executor** for
your user — a second SSE stream delivers the turn's `bash` / `read` / `write` / `edit`
requests, they run in your declared workspace, and results flow back. Everything is
outbound HTTP from the laptop: no open ports, no tunnel, NAT-friendly. Enable
server-side with `channels.web.remoteExec.enabled: true`.

Scope and safety:

- Only turns started by **your user with a connected executor** execute on your machine.
  In login mode the executor is keyed to the logged-in user, so the web UI and desktop
  app share it too — a `⌁ local / ☁ server` toggle in the composer (and `/local on|off`
  in the CLI) opts individual conversations out per message. Schedules and **subagents**
  are unaffected — they run server-side as always.
- Every command asks for confirmation (`y/N/a` — `a` persists a two-token prefix to
  `~/.daedalus/remote-allow.json` so routine commands stop asking). `--yolo` skips the
  prompt, but a denylist of catastrophic patterns (`rm -rf`, `sudo`, `mkfs`, …) ALWAYS
  prompts. File reads/writes are confined to the workspace. Every execution is appended
  to `~/.daedalus/remote-exec.log`.
- Without a TTY the client runs executor-only, and anything that would have prompted is
  refused rather than silently approved.
- Internally, agent containers reach the laptop via the supervisor's `/rpc/exec` bridge,
  guarded by a per-boot shared secret (`DAE_RPC_TOKEN` — set it in the compose `.env`
  when running the warm-worker topology so both containers share it).

## The other channels

- **CLI** — an interactive REPL (`dae serve` with the cli channel enabled): each stdin
  line is a message; replies and attachment notes print to stdout. Good for local dev.
- **Web** — a minimal HTTP + SSE surface. `POST /messages` to send (optionally with
  base64 attachments), `GET /events?externalUserId=…` for the reply stream. A bearer
  token (`web.token`) guards it when set. The built-in chat UI (served at `GET /`) is a
  full session workspace: a sidebar with **Skills & Tools** (the library with lifecycle
  actions — approve/reject pending agent-created skills, pin/unpin, archive; gated on
  `brain.writable`) and **Artifacts** (searchable per-user file catalogue with
  ownership-checked downloads) panels, pinned sessions + title search, a section per
  enabled messaging channel (the cross-channel Main thread, click-to-open), and a
  status bar showing gateway state, agent/cron counts, a context-window readout
  (`65.0k/200.0k · 32%` — the last turn's input tokens vs the agent's `contextWindow`),
  a session timer, and client/backend versions (`GET /status` powers the supervisor
  half). The bar's **agents** and **cron** items are buttons: agents opens the roster
  merged with live activity (`GET /agents` + `GET /activity` — every in-flight turn for
  your user, channel + scheduled, live doing-now labels, click-to-jump; the item pulses
  while anything runs; pairs with the Stop button), cron opens the schedule detail
  (`GET /schedules`). The UI's source lives under `src/web/ui/` (plain HTML/CSS/JS),
  assembled into the served module by `npm run build:web-ui`.
- **WhatsApp** — Cloud API channel (access token + phone-number id), off by default.

Enable channels in `daedalus.config.yaml` under `channels:` (with `enabled: true` and a
`defaultAgent`). `dae install` wires Telegram for you.
