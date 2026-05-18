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

Brain mount becomes RW only if `brain.writable: true` in the supervisor's
config — the supervisor and every agent honor that single setting.

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

`brain/schedules/*.yaml` cron triggers go through the same dispatcher as channel
messages. In docker mode that means each scheduled run spawns its own agent
container with the agent's image, mounts, and OneCLI identity — no work
accidentally happens in the supervisor.

Each schedule gets its own persistent session (synthetic channel `schedule`,
external id = schedule name) so repeated fires accrete history. An
"every 10 minutes status report" agent can see what it reported last time.

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
