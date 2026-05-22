# Docker mode

Daedalus has two operational modes, picked per-install:

- **Host mode** (default — `runtime.dispatcher: process`). `dae serve` runs as
  one Node process on the host; agents and subagents run inside that same
  process; bash tools shell out on the host. Fast iteration, simple to debug;
  zero isolation between agents.

- **Docker mode** (`runtime.dispatcher: container`). `dae serve` runs in a
  *supervisor* container. Each inbound message → supervisor spawns a fresh
  per-message *agent container* (the agent's declared image). Subagents inside
  those containers do the same recursively — every agent at every depth has its
  own filesystem, environment, and OneCLI credential scope. This is the model
  you want in production.

Both modes share the same code paths; the dispatcher abstraction
(`src/dispatch/base.ts`) hides the difference from the kernel.

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
shared services (OneCLI, MemPalace, …) by container name.

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
   MemPalace MCP is the one auto-injected exception — every agent gets
   `memory` automatically when `mempalace.localHttp.enabled: true` in the
   supervisor's config, so every agent can persist + recall memories without
   declaring it.

   > **Gotcha — an explicit def overrides the built-in injection.** The
   > auto-inject only fires when *no* MCP server named `memory` **or**
   > `mempalace` already exists in your mcp config (the guard in `connectAgentMcp`
   > is `!allDefs["memory"] && !allDefs["mempalace"]`). Define either one — a
   > leftover `mcp/memory.json`, or the entry `dae setup mempalace` writes — and
   > it *replaces* the built-in: agents connect to your def instead. If that def
   > points somewhere dead, agents silently get no memory even though
   > `mempalace.localHttp.enabled` looks correct. To use the built-in mempalace,
   > leave `memory`/`mempalace` out of the mcp config entirely.

### The `mempalace` container

MemPalace's own MCP server is **stdio-only** (no HTTP transport). For docker mode
it runs as its own service (`Dockerfile.mempalace` + the `mempalace` service in
`docker-compose.yml`): the image fronts the stdio server with
[`mcp-proxy`](https://github.com/sparfenyuk/mcp-proxy), exposing it over the
network at **`http://mempalace:11364/sse`**. Every agent container reaches it by
that name on the `daedalus` network — no `host.docker.internal`, no per-turn
spawn, one shared instance.

- **Palace persistence.** The on-disk store (chroma + knowledge graph) lives at
  `/palace` in the container. Set `MEMPALACE_PALACE_PATH` in your compose `.env` to
  a host dir (e.g. `/home/you/.daedalus/mempalace`) to bind-mount it; unset falls
  back to the `mempalace-data` named volume.
- **Wiring the connection.** mcp-proxy serves both streamable-HTTP at `/mcp` and
  SSE at `/sse`. The `/mcp` endpoint matches daedalus's built-in auto-inject, so
  the simplest setup needs **no explicit def** — just point the auto-inject at the
  container:
  ```yaml
  mempalace:
    localHttp:
      enabled: true
      host: mempalace      # the container name on the daedalus network
      port: 11364
      urlPath: /mcp
  ```
  That makes every agent get `memory → http://mempalace:11364/mcp` automatically.
  (Prefer SSE, or have a non-daedalus client connect? Use an explicit def instead:
  `{ "mcpServers": { "memory": { "url": "http://mempalace:11364/sse", "transport": "sse" } } }`.)
- **Auth.** The service publishes only to `127.0.0.1` and the internal `daedalus`
  network, so isolation is the boundary. mcp-proxy doesn't enforce a bearer token
  itself — front it with a TLS reverse proxy if you expose it beyond the host.

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

```bash
# 1. Copy / set your daedalus config + .env into the directory you'll bind-mount.
mkdir -p /opt/daedalus/etc
cp daedalus.config.yaml /opt/daedalus/etc/config.yaml

# 2. Set environment for compose
cat > .env <<'EOF'
BRAIN_PATH=/opt/daedalus/brain
DAEDALUS_CONFIG_DIR=/opt/daedalus/etc
ONECLI_API_KEY=oc_…
UID=1000
DOCKER_GID=998
EOF

# 3. Bring it up
docker compose up -d

# 4. Watch the supervisor
docker compose logs -f daedalus
```

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
