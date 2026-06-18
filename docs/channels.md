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

## The other channels

- **CLI** — an interactive REPL (`dae serve` with the cli channel enabled): each stdin
  line is a message; replies and attachment notes print to stdout. Good for local dev.
- **Web** — a minimal HTTP + SSE surface. `POST /messages` to send (optionally with
  base64 attachments), `GET /events?externalUserId=…` for the reply stream. A bearer
  token (`web.token`) guards it when set.
- **WhatsApp** — Cloud API channel (access token + phone-number id), off by default.

Enable channels in `daedalus.config.yaml` under `channels:` (with `enabled: true` and a
`defaultAgent`). `dae install` wires Telegram for you.
