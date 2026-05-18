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
