# Daedalus

> An SDK-agnostic agent runner. CLI: `dae`.

Daedalus is the platform; **your assistant is whatever you name it** (default `Artemis`).
The two are deliberately separated — Daedalus is the architecture; the persona is the
character that performs on it.

[![CI](https://github.com/inline-studio/daedalus/actions/workflows/ci.yml/badge.svg)](https://github.com/inline-studio/daedalus/actions/workflows/ci.yml)

> **Status:** pre-alpha (v0.1). Single-operator deployments work; the API and brain
> layout are still moving. Pin to a specific release if you embed it.

---

## Why

Most agent frameworks today are tightly coupled — one LLM provider, one channel, one
persona — with config scattered across whatever directory happened to be convenient.
Daedalus inverts all of that:

- **Provider-agnostic.** Anthropic, OpenAI, Ollama, vLLM, llama.cpp, LiteLLM gateway,
  anything OpenAI-shaped. Change the agent manifest, not the runner.
- **Brain-repo driven.** Your agents, personas, souls, standards, operations, skills,
  MCP servers, and schedules live in a separate git repo. Sym-link it into Claude
  Code, VS Code, OpenCode — same files, same vault, multiple frontends.
- **Persona / runtime separation.** Your assistant is whatever name you set
  (`dae identity Claudia`). Subagents stay invisible behind it — when they need
  information they bubble a question up through the orchestrator, which phrases it
  in the persona's voice.
- **Channel-unified.** Talk to your assistant from CLI, web (HTTP + SSE), Telegram, or
  WhatsApp. All channels share one session per user; the conversation continues across
  surfaces.
- **Per-agent containers.** Give a coder agent `node:24-alpine`, a php agent
  `php:8-cli`. Tool execution runs in the right runtime; the brain repo auto-mounts
  read-only into every agent.
- **Real memory.** A [Graphiti](https://github.com/getzep/graphiti) temporal
  knowledge-graph MCP. Entities, relationships, and decisions are extracted from each
  turn, with validity tracked over time. Fully local + leak-free — extraction LLM
  and embeddings run on *your* OpenAI-compatible endpoint, routed through the OneCLI
  proxy so no key ever lands on disk.
- **Reversible setup.** Every `dae setup <thing>` has a matching `dae disable <thing>`,
  idempotent by default and `--purge` for a clean slate.

---

## Quick start

```bash
# 1. Install the CLI (both `dae` and `daedalus` go global)
npm install -g https://github.com/inline-studio/daedalus/releases/latest/download/daedalus-latest.tgz
dae --version

# 2. Scaffold a brain and bring the stack up
dae init            # creates ~/.daedalus/ from the shipped example brain
dae install         # asks a few skippable questions, then `docker compose up -d --build`
```

`dae install` asks only what it can't infer (an LLM provider key, optional Telegram /
memory / search), then starts the container stack. Re-running is idempotent.

The `daedalus` container is now serving (it runs `dae serve` as its entrypoint) — you
don't start anything by hand. Talk to your agent through whichever surface you wired:

- **Web:** open `http://127.0.0.1:8765` (loopback-only by default).
- **Telegram:** message your bot (if you gave `dae install` a token).

Watch it work with `docker compose logs -f daedalus`. Keep it current with `dae update`.
Full walkthrough, prerequisites, and provider setup: [docs/install.md](docs/install.md).

---

## How it runs

Daedalus runs as a small **docker-compose stack** — there's no host service to install.
You define agents declaratively (the **brain**); daedalus runs each turn in a container,
reachable over chat channels.

```
You ──chat──▶ channel ──▶ supervisor ──▶ warm worker (top-level agent)
                                              │
                                              ├─ tools / skills / MCP / memory
                                              └─ spawn_subagent ──▶ per-agent containers
LLM + web calls ──▶ OneCLI proxy (injects real keys) ──▶ provider
```

What `dae install` brings up:

| Container | Role |
|---|---|
| `daedalus` | Supervisor + scheduler — owns the channels (long-running). |
| `dae-worker` | Warm agent worker — runs top-level turns without per-message boot. |
| `graphiti` | Temporal knowledge-graph memory MCP (with the `graphiti` profile, when a memory endpoint `SPARK_URL` is set). |
| `onecli` (+ `onecli-db`) | Credential-injecting gateway + its Postgres (always). |
| `whisper` | Local speech-to-text (only with the `whisper` profile). |

Why all-container — isolation of model-generated `bash`, reproducibility, turnkey
bring-up, and a single portable config. Dispatch architecture, per-agent mounts, and the
SSH-key auto-mount: [docs/docker-mode.md](docs/docker-mode.md).

---

## Requirements

- **Node.js 24+** (LTS) — daedalus uses `node:sqlite` and other 24-era APIs.
- **Docker + the compose plugin** — the whole stack runs as containers. On macOS,
  Docker Desktop or [Colima](https://github.com/abiosoft/colima) both work.
- **At least one LLM provider** — Anthropic, OpenAI, or any OpenAI-compatible endpoint
  (LiteLLM, vLLM, Ollama, llama.cpp). The provider is chosen **per agent**, so different
  agents can use different providers in one install.
- **An embeddings endpoint — only if you want memory.** Graphiti needs an OpenAI-shaped
  embeddings model (Anthropic ships none, so an Anthropic-only setup still needs one
  *somewhere*). Skip it and memory simply stays off.

Provider key handling, the embeddings-setup picker, and the install wizard step-by-step:
[docs/install.md](docs/install.md).

---

## Install

### One-shot

```bash
npm install -g https://github.com/inline-studio/daedalus/releases/latest/download/daedalus-latest.tgz
dae --version
dae install
```

Both `dae` and `daedalus` are installed as aliases. `dae install` is a thin wrapper
around `docker compose`: it ensures a config exists, asks the few things it can't infer
(config path, providers, optional memory endpoint / Telegram / whisper / Brave / web
password), writes the compose `.env`, and runs `docker compose up -d --build`. Every
answer is skippable and pre-fills on re-run. Full walkthrough: [docs/install.md](docs/install.md).

Tail the supervisor:

```bash
docker compose -f ~/.daedalus/compose/docker-compose.yml logs -f daedalus
```

Keep it current with `dae update` (fetches the latest release and rebuilds, reusing your
`.env`).

### Linux / Ubuntu PATH note

After `npm install -g`, the `dae` binary lands in `$(npm config get prefix)/bin`. On
Ubuntu that directory is often not in `$PATH`. One-time fix:

```bash
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

### Development install

```bash
git clone git@github.com:inline-studio/daedalus.git
cd daedalus
npm install                  # also runs `prepare` → builds dist/
npm run link:cli             # build + global link; both `dae` and `daedalus` go global
npm test                     # smoke battery
```

---

## The brain

The brain is a directory you point `brain.path` at — usually a separate git repo
sym-linked into `~/.daedalus/brain`. `dae init` scaffolds one from the example that ships
in [examples/brain/](examples/brain/). It's mounted read-only into every agent container,
and read fresh on every turn (so edits take effect on the next message — no restart).

```
brain/
├── agents/<name>.md            agent manifests (YAML frontmatter + body)
├── personas/<name>.md          persona prose injected per agent
├── souls/<name>.md             cross-cutting principles (e.g. "be careful")
├── standards/*.md              always-loaded; e.g. response-style rules
├── operations/*.md             always-loaded; e.g. workspace conventions
├── skills/<name>/SKILL.md      loadable capabilities (+ optional bootstrap.sh)
├── commands/<name>.md          slash-commands (e.g. /ship)
├── mcp/servers.json            MCP server configs (or a directory of them)
├── schedules/*.yaml            cron-driven agent invocations
└── memory/                     optional periodic memory snapshots
```

For each turn the system prompt is composed deterministically:

```
identity → standards → operations → souls → personas → skills → agent body → now
```

`identity` and `now` are auto-injected; everything else comes from your brain. Full
reference — why the orchestrator/subagent shape, composition, customising:
[docs/agents.md](docs/agents.md).

---

## Setting up a new agent

An agent is a single markdown file: YAML frontmatter (its config) and a body (its own
system-prompt segment). Drop it in `brain/agents/<name>.md` — **the filename is the
agent's name** (any `name:` in frontmatter is ignored). It takes effect on the next
message; the brain is read fresh every turn, no restart or rebuild.

```markdown
---
description: Gathers and synthesises information from local files and the web.
provider: openai
model: sonnet
maxTurns: 20
tools: [read, web_search, web_fetch]
skills: [brave-search]
souls: [careful]
personas: [researcher]
---

You are a research specialist. Be thorough but concise. Cite specific files,
line numbers, or URLs whenever you make a claim.
```

Only **`provider`** and **`model`** are required; everything else is optional. The
common fields:

| Field | Default | What it does |
|---|---|---|
| `description` | `""` | One-liner shown in the orchestrator's `spawn_subagent` menu. Make it signal *when* to delegate here — it's all the orchestrator sees when routing. |
| `provider` | — (**required**) | `anthropic`, `openai`, or `ollama`. `openai` covers any OpenAI-compatible endpoint (OpenAI, LiteLLM, vLLM, Ollama `/v1`). Decides the wire protocol and which key resolves. |
| `model` | — (**required**) | Model id passed to the provider (`claude-opus-4-7`, `gpt-4o`, a LiteLLM alias like `sonnet`, …). |
| `tools` | `[]` | Built-in tools: `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`, `schedule_message`, … `['*']` = all. **Empty = none** — the safe default for subagents. |
| `skills` | `[]` | Skills from `brain/skills/`. `['*']` = all. |
| `mcpServers` | `[]` | MCP servers from `brain/mcp/`. `['*']` = all. The `memory` server is auto-injected when Graphiti is on. |
| `commands` | `[]` | Slash-commands from `brain/commands/`. `['*']` = all (recommended for the orchestrator). |
| `subagents` | `[]` | Agents this one may delegate to via `spawn_subagent`. List them explicitly — not wildcarded, so the menu stays small. |
| `souls` / `personas` / `standards` / `operations` | **all** | Shared prompt sections from the matching brain directory. **Omit or leave empty = include every file; name a subset to narrow.** |
| `container` | (warm runtime) | Run this agent's `bash` in a specific image — see below. Omit to run warm in the agent-turn container. |
| `maxTurns` / `maxTokens` | `50` / `4096` | Tool-use iterations per turn / max output tokens per LLM call. |
| `temperature` | provider default | Sampling temperature, 0–2. |
| `vision` | `false` | Image input: `false` = strip images; `true` = `model` is multimodal; `"provider/model"` = describe via a side vision model, then `model` answers. |
| `timeAware` / `timezone` | `true` / system tz | Inject current date/time each turn; IANA tz override (e.g. `Europe/London`). |

> **Gotcha — `souls` / `personas` / `standards` / `operations` default to "all".** Omitting
> the field pulls in *every* file in that directory. Name a subset (e.g. `souls: [careful]`)
> to include only those. (`tools`, `skills`, `mcpServers`, `subagents`, `commands` are the
> opposite: empty = none.)

### Per-agent container

Set `container.image` to run the agent's `bash` in a specific toolchain image — each
command runs in a fresh `docker run --rm` of that image, good for isolated build/test
leaves. Omit it for warm, interactive, or stateful work (the orchestrator, browser
tools): `bash` then runs persistently in the agent-turn container.

```yaml
container:
  image: ghcr.io/inline-studio/dev-node:latest
  workdir: /workspace        # default; brain auto-mounts read-only at /brain
  bind: ["/host/path:/in/container:ro"]
```

The shipped [`examples/brain/agents/`](examples/brain/agents/) has three worked
manifests — an orchestrator, a containerised coder, and a read-only researcher.
Full reference (every field, `vision` modes, container tradeoffs):
[docs/agents.md](docs/agents.md).

---

## Skills

A **skill** packages a capability — instructions for the model plus an optional install
script for any binary it needs. Skills live in `brain/skills/<name>/` and are pulled into
an agent via its `skills:` list (`['*']` = all).

```
brain/skills/my-skill/
├── SKILL.md          frontmatter + instructions  (required)
└── bootstrap.sh      install script              (optional)
```

```markdown
---
description: "What this skill does — written to clearly signal WHEN to use it."
toolsRequired: [bash, web_fetch]   # built-in tools the skill leans on
requires:
  secrets: [MY_API_KEY]            # secrets that must resolve when the skill loads
---

Use this skill when you need X. Run `my-tool …` for the common case.
```

Two things worth knowing up front:

- **Progressive disclosure.** Only the `description` is in the prompt up front; the body
  loads on demand via `load_skill`. A vague description means the agent never reaches for
  the skill — write it to signal *when* to use it.
- **`bootstrap.sh` is user-space only.** It runs once per content-hash before the turn and
  **cannot** `apt-get install` (no root). Anything needing system libraries must be baked
  into the agent image, not installed at runtime.

Full reference — the `bootstrap.sh` contract, the daedalus image, the default per-stack
images, and the `agent-browser` worked example: [docs/skills.md](docs/skills.md).

---

## MCP servers

Agents reach external tools through [MCP](https://modelcontextprotocol.io) servers
declared in the brain. Point `mcp.configPath` at `brain/mcp/`; daedalus reads every
`*.json` file and merges them — one server per file (named after the file) is the
recommended layout, so you add a capability by dropping in a file and remove it by
deleting the file.

```json
// brain/mcp/github.json  →  server "github"
{ "mcpServers": { "default": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }
```

stdio (`command`) and http/sse (`url` + `transport`) servers are both supported; `${VAR}`
in `env`/`headers` keeps secrets out of the JSON. An agent connects the servers in its
`mcpServers:` list (`['*']` = all); the `memory` server is auto-injected. Full reference:
[docs/mcp.md](docs/mcp.md).

---

## Channels

A **channel** is an inbound/outbound surface. They're **not** separate conversations —
every channel publishes into the same per-user session pool, so a user who reaches you on
Telegram and on Web shares one history.

- **Telegram** (primary) — long-polling via a `@BotFather` bot, so no public port or
  webhook; carries photos, voice notes, and documents both directions.
- **Web** — HTTP + SSE surface at `http://127.0.0.1:8765`, optional bearer-token login.
- **CLI** — interactive REPL over stdin/stdout (`dae serve`); good for local dev.
- **WhatsApp** — Cloud API channel, off by default.

Inbound photos become image parts; voice notes are transcribed; agents send files back
with the `attach_to_reply` tool. Full reference: [docs/channels.md](docs/channels.md).

---

## Memory

Memory is a **Graphiti** temporal knowledge-graph MCP, auto-injected as the `memory`
server on every agent when enabled. Entities, relationships, and decisions are extracted
from each turn with validity tracked over time. Extraction + embeddings run on an
OpenAI-compatible endpoint you configure (`SPARK_URL`), reached through the OneCLI proxy,
so no key hits disk, and the whole graph is one portable bind-mounted directory.

Enable it by giving `dae install` that endpoint's URL (`SPARK_URL`) — usually the same as
your OpenAI base URL. Embeddings-setup options: [docs/install.md](docs/install.md).
The `graphiti` container internals and exposing memory to other devices:
[docs/docker-mode.md](docs/docker-mode.md).

---

## Secrets

API keys never live in the YAML config or the brain. They live in **OneCLI** — a local
HTTPS MITM proxy that injects the right header on outbound requests to the right host.
Agents only ever hold the placeholder string `onecli-managed`, so a key never lands in
the brain, the config, agent prompts, or logs.

`dae install` registers your Anthropic / OpenAI / Brave keys automatically. For other
third-party keys, register the injection manually (`dae secret save NAME -u <host> -H
<header> -F <format>`). Day-to-day commands are in [`dae commands`](#dae-commands) below;
the credential model and the manual injection form: [docs/install.md](docs/install.md).

---

## `dae` commands

### Top-level

| Command | What it does |
|---|---|
| `dae init` | Bootstrap `~/.daedalus/` from the shipped example |
| `dae install` | Turnkey: ensure config, then `docker compose up -d` the stack |
| `dae update` | Check for a newer release, install it, re-apply your configuration |
| `dae uninstall [--purge]` | Stop the stack (`--purge` also deletes config; data preserved) |
| `dae serve` | The long-running supervisor (channels + scheduler + dispatcher). The `daedalus` container runs this as its entrypoint, so in the normal stack you **never run it by hand** — operate via `docker compose` (see below). Host/dev-mode only. |
| `dae agents` / `dae skills` / `dae mcp` | Browse what's in the brain |
| `dae config` | Print the resolved config as JSON |
| `dae identity [name] [--nickname N]` | Show or change the orchestrator's persona name |
| `dae export mempalace [--host]` | Migrate data out of a legacy MemPalace store |

### Setup / disable (every setup has a symmetric disable)

```bash
dae setup                                   # interactive guided wizard
dae setup [telegram|whatsapp|search|onecli|whisper]
dae setup --list

dae disable <thing>                         # idempotent; secrets preserved
dae disable <thing> --purge [--yes]         # clean slate: removes config + secrets
dae disable --list
```

### Secrets

```bash
dae secret save <NAME>                                          # silent prompt
dae secret save <NAME> -v <value>                               # non-interactive
dae secret save <NAME> -u <pattern> -H <header> -F <format>     # OneCLI injection
dae secret get <NAME>                                           # stdout-clean
dae secret list                                                 # names only
dae secret delete <NAME>
dae secret backend                                              # show active backend
```

### Schedules

```bash
dae schedule                                # run all loaded schedules in the foreground
```

(In the deployed stack, the supervisor runs the scheduler automatically — `dae schedule`
is for ad-hoc development.)

### Running as a service (docker compose)

`dae install` writes a `.env` next to `docker-compose.yml` and brings everything up.
After that, manage with plain compose:

```bash
docker compose ps                           # is the daedalus container up?
docker compose up -d                        # start the stack
docker compose --profile whisper up -d      # also start local whisper STT
docker compose logs -f daedalus             # tail the supervisor (this IS the live `dae serve` output)
docker compose restart daedalus             # restart the supervisor (e.g. after a config change)
docker compose up -d --build                # rebuild + restart after `dae update`
```

`restart: unless-stopped` on each service means the stack comes back on boot once the
Docker daemon starts.

> **Don't run `dae serve` on the host while the stack is up.** The container is already
> the supervisor; a second host-side `dae serve` will fail — and the failures are expected,
> not a broken install:
> - **`fetch failed` / `getContainerConfig failed`** — the stack's config points OneCLI at
>   `http://onecli:10254`, a hostname that only resolves *inside* the `daedalus` docker
>   network. From the bare host there's no such DNS. (The in-process default is
>   `localhost:10254`; an `onecli` host means it's the container's config.)
> - **`EADDRINUSE :::8765`** — the running container already publishes port 8765 to the
>   host, so a second server can't bind it. This is proof the supervisor is already serving.
>
> To inspect or control it, use `docker compose` (above), not `dae serve`. The bare-host
> `dae serve` is only for a non-docker host/dev deployment — a config pointing at
> `localhost` (or OneCLI disabled) and a free port 8765.

---

## Documentation

The [`docs/`](docs/README.md) tree has the full detail behind every section above:

- [`docs/install.md`](docs/install.md) — installation, providers, embeddings, Brave, memory, OneCLI, the Docker choice
- [`docs/agents.md`](docs/agents.md) — agent manifests, full frontmatter reference, container settings, prompt composition
- [`docs/skills.md`](docs/skills.md) — building skills, the `bootstrap.sh` contract, the daedalus image
- [`docs/channels.md`](docs/channels.md) — Telegram, CLI/Web/WhatsApp, inbound / outbound attachments
- [`docs/mcp.md`](docs/mcp.md) — MCP server configuration
- [`docs/docker-mode.md`](docs/docker-mode.md) — dispatch architecture, per-agent mounts, SSH key auto-mount
- [`CHANGELOG.md`](CHANGELOG.md) — recent user-facing changes, by release

---

## Testing

```bash
npm test                                  # CI-safe + CLI-spawning smokes (default outside CI)
DAE_TEST_SCOPE=ci npm test                # CI-only subset; what GitHub Actions runs
DAE_TEST_SCOPE=all npm test               # everything including Docker-dependent tests
```

## License

MIT (placeholder).
