# Docker mode

Daedalus runs as docker containers. `dae serve` runs in a long-lived
*supervisor* container; each inbound message → the supervisor spawns a fresh
per-message *agent container* (the agent's declared image). Subagents inside
those containers do the same recursively — every agent at every depth has its
own filesystem, environment, and OneCLI credential scope. Shared services
(memory, OneCLI) are their own containers on the `daedalus` network. No agent
code runs on the host; that's the isolation model.

> **Host mode is retired.** Earlier versions could run `dae serve` in-process on
> the host (`runtime.dispatcher: process`). That's no longer a supported
> deployment: the dispatcher defaults to `container`, and the supervisor runs as
> the compose `daedalus` service. (The `process` dispatcher branch survives only as
> a non-docker fallback / for in-process subagent delegation.)

The dispatcher abstraction (`src/dispatch/base.ts`) hides the spawn mechanics
from the kernel.

## The picture

```
+-------------------------------------------+
| daedalus (supervisor container)           |
|   - dae serve                              |
|   - listens on channels (Telegram, web…)   |
|   - owns sessions.sqlite + attachments     |
|   - mounts /var/run/docker.sock            |
+----------------------+--------------------+
                       |
                       | docker run --rm
                       v
+-------------------------------------------+
| agent X container (per-message, ephemeral)|
|   - dae agent-turn --agent X …             |
|   - reads its session tail from /data      |
|   - runs ONE kernel turn, persists reply   |
|   - exits with a JSON DispatchResult       |
+----------------------+--------------------+
                       |
                       | docker run --rm  (if kernel called spawn_subagent)
                       v
+-------------------------------------------+
| subagent Y container                       |
|   - same shape; uses Y's container.image   |
+-------------------------------------------+
```

All containers join the `daedalus` docker network so they reach each other and
shared services (OneCLI, Graphiti, …) by container name.

## Per-agent mounts

Every spawned agent container gets:

| Host path                          | Container path              | Mode | Why                                          |
| ---------------------------------- | --------------------------- | ---- | -------------------------------------------- |
| `<brain>` from compose             | `/brain`                    | ro   | personas + skills + souls + mcp config       |
| `daedalus-shared` volume           | `/shared`                   | rw   | cross-agent scratch; every agent can write   |
| `daedalus-data` volume             | `/data`                     | rw   | sessions sqlite + attachments                |
| config dir from compose            | `/etc/daedalus`             | ro   | daedalus.config.yaml + .env.local            |
| `/var/run/docker.sock`             | `/var/run/docker.sock`      | rw   | nested subagent spawning                     |
| `dae-runtime` named volume         | `/dae-runtime`              | ro   | injected Node + daedalus (see below)         |

Brain mount becomes RW only if `brain.writable: true` in the supervisor's
config — the supervisor and every agent honor that single setting.

### Giving agents an SSH key

Drop key material into `<configDir>/ssh/` on the host (alongside
`config.yaml`) and every agent picks it up automatically — no per-agent
wiring, no extra env vars.

```bash
mkdir -p ~/daedalus/ssh && chmod 700 ~/daedalus/ssh
ssh-keygen -t ed25519 -f ~/daedalus/ssh/id_ed25519 -N "" -C "daedalus@<host>"
chmod 600 ~/daedalus/ssh/id_ed25519
ssh-keyscan github.com >> ~/daedalus/ssh/known_hosts
# Register the .pub wherever the agents need to reach (GitHub deploy key, etc.)
```

The agent-turn shim (`runtime/setup-ssh.sh`) symlinks each file from
`/etc/daedalus/ssh/` (the in-container view of the host dir) into
`$HOME/.ssh/` on every container start, and writes a minimal
`~/.ssh/config` with `StrictModes no`.

Why `StrictModes no` — the host file is `0600` owned by the host user
(uid ~1000), but agent containers run as root (uid 0); SSH would
otherwise reject the key as "owned by someone else." The check guards
against another user on a multi-tenant box swapping your key — irrelevant
when the file is bind-mounted ro from a path you control.

If an agent has already placed its own `$HOME/.ssh/<name>` or
`$HOME/.ssh/config` (e.g. via a skill bootstrap), the shim leaves it
alone — agent-written files always win over the host-mounted defaults.

## Agent images can be anything (with a glibc + a shell)

The supervisor mounts its own Node binary + daedalus install into every
per-agent container at `/dae-runtime` and overrides the container's entrypoint
to use them. So your agent images don't need Node, npm, or daedalus
pre-installed — `python:3.12-slim`, `golang:1.22`, `mcr.microsoft.com/playwright`,
some random third-party image you can't modify — they all just work.

What an agent image **does** need:

- A POSIX shell at `/bin/sh` (every common base image has this).
- A glibc-compatible libc: debian/ubuntu, fedora/rhel/almalinux, oraclelinux,
  amazonlinux. Anything where the supervisor's Node binary can dynamically link
  against the image's libc.

**Not supported (yet):** musl-based images like `alpine`. The Node binary
mounted from `/dae-runtime/node` is glibc-linked and segfaults on musl. If you
need an alpine-based agent, either base it on `node:24-alpine` and install
daedalus into the image (the legacy path — see below), or use a slim Debian
variant of the same toolchain.

How the runtime gets there: the `dae-runtime-init` service in
`docker-compose.yml` runs once at `docker compose up`, copies
`/dae-runtime/{node,daedalus,agent-turn.sh}` from the daedalus image into a
named volume (`daedalus_dae-runtime`), and exits. The supervisor mounts that
volume read-only into every container it spawns. The `entrypoint` of the
container is rewritten to `/dae-runtime/agent-turn.sh`, which execs the bundled
Node + daedalus regardless of what was in the image's CMD/ENTRYPOINT.

**Opt out** — if you've already baked daedalus into your agent image and prefer
the older behaviour where the image's own `dae` is invoked from PATH, set
`DAE_AGENT_RUNTIME_INJECT=false` on the supervisor (or unset
`DAE_AGENT_RUNTIME_VOLUME`). The dispatcher will fall back to running
`dae agent-turn …` against the image's PATH.

## Skill-installed binaries (gh, doctl, agent-browser, …)

Skills that depend on a CLI binary (e.g. `gh` for GitHub, `doctl` for
DigitalOcean) ship a `bootstrap.sh` next to their `SKILL.md`. Daedalus runs
each bootstrap exactly once per content-hash, downloading the binary into
`/data/skill-bin/bin/` — which is automatically prepended to `$PATH` for every
`bash` tool invocation. Because `/data` is on a persistent volume, the binary
sticks across container restarts and across new agent dispatches.

The bootstrap contract:

- **Idempotent**: fast-path with `command -v <bin> >/dev/null && exit 0`.
- **Install destination**: `$DAE_SKILL_PATH_DIR` (the shared `/data/skill-bin/bin/`)
  for binaries; `$DAE_SKILL_BIN` (a per-skill subdir) for scratch like npm
  prefixes, gem homes, or venvs.
- **Non-fatal failure**: a bootstrap that exits non-zero is logged but doesn't
  abort the agent turn. The skill body should describe a curl fallback for
  this case.

Example (`brain/skills/github-api/bootstrap.sh`):

```sh
#!/bin/sh
set -e
command -v gh >/dev/null 2>&1 && exit 0
ARCH=$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/')
ver=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest \
  | grep tag_name | head -1 | cut -d'"' -f4 | sed 's/^v//')
tmp=$(mktemp -d)
curl -fsSL "https://github.com/cli/cli/releases/download/v${ver}/gh_${ver}_linux_${ARCH}.tar.gz" \
  | tar -xz -C "$tmp"
mv "$tmp/gh_${ver}_linux_${ARCH}/bin/gh" "$DAE_SKILL_PATH_DIR/gh"
chmod +x "$DAE_SKILL_PATH_DIR/gh"
rm -rf "$tmp"
```

First run: ~5s download. Every subsequent run: instant. No edits to the agent's
base image required.

## Slash-commands (`/ship`, `/standup`, …)

Prompt templates the user can invoke from chat. Each lives at
`<brain>/commands/<name>.md` with optional frontmatter:

```markdown
---
description: stage, commit, push       # shown in the agent's system-prompt menu
aliases: [s, send]                     # alternate names the user can type
---

Run `git status`, then stage and commit everything, then push.
```

The frontmatter — and every field in it — is **optional**; a bare body works. The
command's **name** is its filename. `description` (default `""`) shows in the agent's
command menu; `aliases` (default `[]`) are alternate names the user can type.

**Manifest opt-in.** An agent only sees commands when its manifest declares
`commands:`. Three shapes:

```yaml
commands: ['*']               # all commands in <brain>/commands/
commands: ['ship', 'standup'] # named subset
# (omit)                      # no commands — the default; typical for subagents
```

The orchestrator usually gets `['*']`; subagents typically get none, so a user
typing `/ship` to a subagent doesn't accidentally trigger anything.

**Runtime behaviour.** When the user's message starts with `/<word>`:

1. Daedalus checks the receiving agent's loaded commands for a match by name
   or alias (case-insensitive).
2. If matched, the command body is prepended to the user message as a clearly-
   labelled preamble (`[slash-command /ship invoked — instructions follow] …
   [end of /ship instructions; user-provided args below]`), and any args after
   the command name follow as a second text block.
3. If no match, the message passes through unchanged so the agent can handle
   "is this a typo?" itself.

The expansion happens once in the supervisor's ingest step — the persisted
user message contains the full expanded prompt, so subagents and history all
see what the agent saw.

## Tool scoping

Two enforcement points:

1. **Built-in tools.** `selectBuiltins(manifest.tools, config)` returns
   strictly what the manifest declares — an empty `tools:` list now means no
   built-in tools, *not* the previous "all of them" footgun. Only the
   orchestrator manifest should list `web_search`, `web_fetch`, `bash`,
   `write`, etc.; subagents that don't need them won't have them.

2. **MCP servers.** `mcpServers:` in the manifest is the allowlist. The
   Graphiti memory MCP is the one auto-injected exception — every agent gets
   `memory` automatically when `graphiti.enabled: true` in the supervisor's
   config, so every agent can persist + recall memories without declaring it.

   > **Gotcha — an explicit def overrides the built-in injection.** The
   > auto-inject only fires when *no* MCP server named `memory` already exists in
   > your mcp config (the guard in `resolveAgentMcpDefs` is `!allDefs["memory"]`).
   > Define one — e.g. a leftover `mcp/memory.json` — and it *replaces* the
   > built-in: agents connect to your def instead. If that def points somewhere
   > dead, agents silently get no memory even though `graphiti.enabled` looks
   > correct. To use the built-in Graphiti memory, leave `memory` out of the mcp
   > config entirely.

### Migrating off MemPalace

MemPalace has been **removed from the stack** — Graphiti (below) is the memory backend.
If you ran an older daedalus, your config may still carry a `mempalace:` block; it's
harmless (the schema keeps the field only so old configs still validate) and no longer
wired up. To pull data **out** of an existing palace before decommissioning it,
`dae export mempalace` still works.

### The `graphiti` container (temporal-graph memory)

[Graphiti](https://github.com/getzep/graphiti) is daedalus's memory backend — a **temporal
knowledge graph** that extracts entities/relationships/decisions from conversations and
tracks *when* facts held, not just snapshots. It runs as one container — built from
`Dockerfile.graphiti`, a thin pinned layer over Zep's bundled FalkorDB + MCP image — and is
reached at `http://graphiti:8000/mcp/` on the daedalus network.

It stays **local + leak-free**: the graph store is on local disk, and the extraction LLM +
embeddings run on **your own OpenAI-compatible endpoint** (`SPARK_URL`), reached **through the
OneCLI proxy** — so its key is never written to disk (OneCLI injects it per request). The image
also disables graphiti-core's PostHog telemetry and points its cross-encoder reranker at that
same endpoint, so nothing phones home.

`dae install` wires all of this **automatically** when you configure an OpenAI-compatible
endpoint (`SPARK_URL`) — there's nothing to hand-edit. It:
- builds `Dockerfile.graphiti` and starts the `graphiti` service (its profile is merged into
  `COMPOSE_PROFILES` alongside whisper — never overwritten);
- sets `memory.backend: graphiti` + `graphiti.enabled: true` in your config;
- writes `SPARK_URL`, a host `GRAPHITI_DATA_PATH`, and — after OneCLI is up — the OneCLI
  proxy URL + CA into the compose `.env`, so graphiti routes egress through OneCLI.

`dae update` re-checks and self-heals this (re-fetches the proxy/CA, keeps the merged profile
set). Knobs with sane defaults you can override in `.env`: `GRAPHITI_LLM_MODEL` (default
`artemis`, a capable INSTRUCT model), `GRAPHITI_EMBED_MODEL` (`embeddings`), `GRAPHITI_EMBED_DIM`
(`768` — must match your embeddings model's dimension).

> **Why a custom image?** The upstream `openai` provider uses the OpenAI **Responses API**,
> which litellm-fronted local models don't enforce structured outputs on, so extraction fails.
> `Dockerfile.graphiti` patches the factory to use the **chat.completions** client (which they
> *do* enforce json-schema on), disables telemetry, and trusts the OneCLI CA at startup.

**Verify (leak-check + recall):**
- Egress: confirm graphiti talks only to your configured endpoint — watch `docker compose logs
  onecli` for `url=https://<your-endpoint-host>/...` and **no** unexpected `posthog.com`.
- Recall: have an agent remember a fact, then ask for it back. Recall needs your
  **embeddings** model up — every query is embedded, so if embeddings is down, recall returns
  nothing (the rest of the agent still works).

**Portability (transfer to a new machine):** the whole store is one directory —
`GRAPHITI_DATA_PATH` (bind-mounted to `/var/lib/falkordb/data`). To move: **graceful-stop**
the stack (so FalkorDB flushes its snapshot), copy that directory to the new host, run
`dae install`/`dae update` there, and start the stack. The graph data, the vector embeddings,
and the indices all travel in the snapshot — **no reindex needed**; recall works as soon as the
embeddings endpoint is reachable again.

> Daedalus orchestrates *around* this store — Graphiti provides the storage, extraction,
> and graph search; daedalus decides when to write, recall, and consolidate.
> **Auto-save is implemented** (`memory.autoSave`, on by default when graphiti is enabled): a
> curator pass after each top-level turn distils durable facts and writes them via the
> backend's add tool, so memory isn't left entirely to the model remembering to call the
> tools. Proactive recall and the scheduled "dream" consolidation are still on the roadmap.

## The web chat UI

The `web` channel ships a built-in, zero-dependency chat UI — a single HTML page the
channel serves at **`GET /`** on its own port. It talks to the same channel API it's served
from (`POST /messages`, `GET /events` SSE, `GET /history`), so it's the *same* conversation
+ memory as any other channel — a reply you got on Telegram shows up here too, and Graphiti
memory is shared. It supports streaming replies, **file uploads** (images / PDFs / docs →
the agent's vision/pdf skills), **file responses** (attachments the agent sends back render
inline / as downloads), Markdown, and history that survives reloads.

Enable it in `~/.daedalus/config.yaml`:
```yaml
channels:
  web:
    enabled: true
    defaultAgent: orchestrator
    port: 8765
    # token: ${WEB_TOKEN}   # optional bearer token (see auth below)
```

The supervisor publishes the port to **loopback** by default (`127.0.0.1:8765`). As with
mempalace before it, **daedalus bundles no web server** — front the port with **your own**
reverse proxy for TLS + auth:

1. **Reach the port.** Loopback is fine if your proxy runs on the host. If it runs elsewhere
   (another container/host), set `WEB_BIND=0.0.0.0` in the compose `.env` so it can connect.
2. **Terminate TLS + authenticate at your proxy** (Caddy `basic_auth` / `forward_auth` / mTLS).
   Example Caddy:
   ```caddy
   chat.example.com {
       reverse_proxy 127.0.0.1:8765 {
           flush_interval -1   # don't buffer the SSE reply stream
       }
   }
   ```
3. **Open the UI** at your proxy URL. The page loads unauthenticated (it's just the app
   shell); its API calls then carry the credential. If you also set `channels.web.token`,
   the UI prompts for it once (stored in your browser) — belt-and-suspenders behind the proxy.
   The page check (`GET /`) is intentionally unauthenticated so it can load and *then* auth.

## Scheduled tasks

Two flavours, both go through the same dispatcher and both spawn per-agent
containers in docker mode.

**Static (`brain/schedules/*.yaml`).** Cron triggers loaded at supervisor
startup. Useful for "every morning at 7 summarise yesterday."

**Runtime (`schedule_message` tool).** An agent arms a callback at runtime —
`schedule_message(when: "in 30 minutes", prompt: "remind me to ship X")` or
`schedule_message(when: "*/10 * * * *", prompt: "report build progress")`. The
row goes into a `scheduled_messages` sqlite table next to sessions; the
supervisor polls it (default every 30s) and dispatches due rows. One-shots fire
once; cron rows re-arm with their next occurrence.

Agents can also `cancel_scheduled_message(id)` to call off recurring callbacks
once the underlying work is done, or `list_scheduled_messages()` to see what's
armed. Cancellation is **creator-scoped** — an agent can only cancel its own
schedules, so subagents can't reach into a sibling's callbacks.

Each schedule (static or runtime) gets its own persistent session — synthetic
channel `schedule` / `scheduled`, external id = schedule name or row id — so
repeated fires accrete history. "Every 10 minutes status report" can see what
it reported last time.

Tools to declare in an agent's manifest when you want it to schedule:

```yaml
tools:
  - schedule_message
  - cancel_scheduled_message
  - list_scheduled_messages
```

Typical pattern for a long-running flow:

```
user → artemis: "build feature X"
artemis → cypher (subagent): "build feature X, write progress to /shared/cypher.log"
artemis → schedule_message(in: 10m, prompt: "check cypher's progress on X")
  ... 10 min later ...
artemis (woken by schedule fire) → reads /shared/cypher.log
artemis → user: "still working on the migration; will update again in 10m"
artemis → schedule_message(in: 10m, prompt: "check cypher's progress on X")
  ... eventually cypher finishes ...
artemis (next fire) → reads log, sees DONE, calls cancel_scheduled_message
artemis → user: "shipped feature X"
```

## OneCLI credential isolation per agent

Each spawned agent container calls `OneCLI.getContainerConfig(agent)` at
startup with **its own** agent identifier (passed via `DAE_ONECLI_AGENT`).
That means OneCLI only injects credentials the *specific agent* has been
granted access to — not whatever the supervisor's agent identity has.

Create an OneCLI agent per daedalus agent and assign secrets selectively:

```bash
onecli agents create --name "Research" --identifier research
onecli agents set-secrets --id <research-uuid> --secret-ids <brave-uuid>,<github-uuid>
```

## Quick start

The easy path is **`dae install`** — it ensures a config exists, asks the three
questions it can't infer (local whisper? Telegram token? memory auth token?), writes
the compose `.env` for you, and runs `docker compose up -d`:

```bash
dae install
docker compose logs -f daedalus
```

### Manual equivalent

If you'd rather wire it by hand:

```bash
# 1. Point the bind-mounts at your config dir + brain.
cat > .env <<'EOF'
BRAIN_PATH=/home/you/.daedalus/brain
DAEDALUS_CONFIG_DIR=/home/you/.daedalus
UID=1000
DOCKER_GID=998
ONECLI_API_KEY=oc_…
# Graphiti memory (the `graphiti` profile). SPARK_URL is your OpenAI-compatible base
# URL; its key is NOT put here — graphiti routes through OneCLI, which injects it.
COMPOSE_PROFILES=graphiti              # comma-join with whisper if you use both
SPARK_URL=https://your-endpoint.example/v1
GRAPHITI_DATA_PATH=/home/you/.daedalus/graphiti
# ONECLI_PROXY_URL + ONECLI_CA_PATH are written by `dae install` AFTER OneCLI is up
# (it fetches OneCLI's proxy URL + MITM CA). Hand-wiring them is fiddly — prefer
# `dae install`, which does the two-phase bring-up + provisioning for you.
EOF

# 2. Bring it up (add --profile whisper for local STT). Note: graphiti needs the OneCLI
#    proxy/CA provisioned first — `dae install` handles that ordering automatically.
docker compose up -d
docker compose logs -f daedalus
```

One config file works for host-side commands (`dae install`) and inside the container:
the image sets `BRAIN_PATH=/brain`, `DAE_DATA_DIR=/data`, `DAE_SHARED_DIR=/shared`, so the
config's host-relative paths are remapped to the container mount points automatically.

Inbound messages on the configured channels (Telegram, etc) will spawn
per-message agent containers automatically.

## Building the image

The default compose pulls `ghcr.io/inline-studio/daedalus:latest`. Build
locally from this repo with:

```bash
docker compose build daedalus
```

The `Dockerfile` is intentionally minimal — node:24-slim + bash/git/curl/jq —
so individual agents can specify richer images via `container.image:` in their
manifest when they need PHP, Python, Chromium, etc.
