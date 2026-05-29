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

## What `dae` offers

Capabilities you get out of the box once `dae install` completes:

| Capability | Notes |
|---|---|
| **Orchestrator + subagents** | One user-facing persona; subagents are invisible. `spawn_subagent` is a built-in tool; `ask_user` bubbles questions up through whatever channel the user last used. |
| **Built-in tools** | `bash`, `read`, `write`, `edit`, `glob`, `web_fetch`, `web_search`, `attach_to_reply`, `schedule_message`, plus `load_skill` / `spawn_subagent` / `ask_user`. Each agent's manifest picks the subset it gets. |
| **Skills with progressive disclosure** | Skills live in `brain/skills/<name>/`. Their one-line description appears in the system prompt; the full body loads on demand via `load_skill`. A `bootstrap.sh` next to `SKILL.md` runs once per content-hash to install user-space dependencies. |
| **MCP servers** | One JSON file per server (or a directory of them) under `brain/mcp/`. The `memory` server is auto-injected when Graphiti is enabled. |
| **Channels** | CLI, web (HTTP + SSE + login or token), Telegram (long-poll, inbound images / voice / docs / outbound rendered as Telegram HTML), WhatsApp (outbound). |
| **Vision + voice in** | Telegram photos arrive as image content blocks. Voice notes are transcribed (OpenAI Whisper API or a local whisper.cpp container) before reaching the agent. |
| **Scheduling** | `brain/schedules/*.yaml` for cron-driven invocations; `schedule_message` for time-based self-reminders. |
| **Memory** | Graphiti temporal knowledge graph, auto-mounted on every agent as the `memory` MCP. Whole store is one portable directory. |
| **Per-user sessions** | SQLite-backed conversation history keyed by `(user_id, agent_name)`. The same session is visible whether you reach the agent over Telegram or web. |
| **Compaction + token budgets** | Old tool-call loops get stubbed on replay to keep the input window bounded; recent N loops always stay full-fidelity. |
| **OneCLI credential gateway** | API keys live in one vault and get injected on the wire by an HTTPS MITM proxy. The runner only ever holds the placeholder `onecli-managed`. |
| **SSH key auto-mount** | Drop a key at `<configDir>/ssh/id_ed25519`; every agent container symlinks it into `~/.ssh/` on start. |
| **Web UI** | Markdown rendering (bold, italic, code, tables, images), file uploads, SSE reply stream with auto-replay across reconnect gaps, optional login mode. |

---

## Requirements

### Runtime

- **Node.js 24+** (LTS). Daedalus uses `node:sqlite` and other 24-era APIs.
- **Docker + the compose plugin.** The whole stack (supervisor, agent worker, memory,
  OneCLI, optional whisper) runs as containers. macOS users: Docker Desktop or
  [Colima](https://github.com/abiosoft/colima) are both fine.

### An LLM provider

Daedalus is provider-agnostic, but you need at least one configured. Pick by agent —
different agents can use different providers in the same install.

#### OpenAI (and OpenAI-compatible)

- **What you need:** an API base URL (`https://api.openai.com/v1`, your LiteLLM proxy,
  Ollama at `http://localhost:11434/v1`, vLLM, llama.cpp, …) and an API key.
- **What `dae install` does:** writes `providers.openai.baseUrl` to the config and
  registers the key in OneCLI, scoped to inject `Authorization: Bearer <key>` on
  requests to that base URL's host.
- **Embeddings:** if your endpoint exposes an OpenAI-shaped `/v1/embeddings` route
  (LiteLLM, vLLM, Ollama all do), Graphiti memory can use it directly — see below.

#### Anthropic

- **What you need:** an Anthropic API key.
- **What `dae install` does:** registers the key in OneCLI, scoped to inject
  `x-api-key: <key>` on requests to `api.anthropic.com`.
- **Embeddings caveat:** Anthropic doesn't ship an embeddings API. If you want memory
  (Graphiti), you need an embeddings endpoint *somewhere* — see below.

### Embeddings model (only if you want memory)

Graphiti memory extracts entities + relationships from each turn via a capable
INSTRUCT model, then writes embeddings for semantic recall. Both must be reachable
via an OpenAI-shaped API at one base URL (the `SPARK_URL` in compose `.env`).

The cleanest setups:

- **OpenAI-only:** `text-embedding-3-small` (1536 dims) on OpenAI directly.
  `GRAPHITI_EMBED_MODEL=text-embedding-3-small`, `GRAPHITI_EMBED_DIM=1536`.
- **LiteLLM in front of multiple providers:** front Anthropic for the extraction LLM
  *and* OpenAI (or a local server) for embeddings under a single base URL. The
  in-line.studio default points at `https://litellm.in-line.studio/v1` for exactly
  this reason.
- **Fully local:** [Ollama](https://ollama.com) serves both. Pull a chat model + an
  embeddings model (`ollama pull nomic-embed-text` gives you 768-dim embeddings,
  which matches the default `GRAPHITI_EMBED_DIM=768`).
- **Anthropic + a separate embeddings endpoint:** Anthropic for the chat model on
  one provider entry; a small Ollama/local container for embeddings under
  `SPARK_URL`. Tell `dae install` your embeddings base URL when it asks; the
  Anthropic key still gets registered in OneCLI for chat traffic.

If you don't want memory at all, skip it — `dae install` won't enable the
`graphiti` profile and no embeddings model is needed.

---

## Install

### One-shot

```bash
npm install -g https://github.com/inline-studio/daedalus/releases/latest/download/daedalus-latest.tgz
dae --version
dae install
```

Both `dae` and `daedalus` are installed as aliases.

Keep it current with:

```bash
dae update
```

### Walkthrough

`dae install` is a thin wrapper around `docker compose`. It ensures a config exists,
asks the few things it can't infer, writes the config + the compose `.env`, then runs
`docker compose up -d --build` to bring the stack up.

The questions on a fresh run (each one is skippable; previous answers pre-fill on
re-run):

1. **Where should the config live?** Defaults to `~/.daedalus/config.yaml`. Pick a
   path that contains the brain (or a sym-link to it) — the config dir is also where
   `.env.local`, the compose dir, and (if you opt in) the SSH-key dir all sit.

2. **Use Anthropic?** If yes, paste the API key. Stored in OneCLI, injected on the wire.

3. **Use an OpenAI-compatible endpoint?** If yes, give the **base URL** (must include
   `/v1`) and the **API key**. Stored in OneCLI, injected on the wire.

4. **Spark URL for memory?** (Only asked if you're enabling at least one provider.)
   This is the embeddings + extraction endpoint Graphiti will reach. Usually the same
   as your OpenAI base URL. Skip this to install without memory.

5. **Telegram bot token?** Optional. Skipped → no Telegram channel.

6. **Local whisper for voice notes?** Optional. Skipped → voice notes only work if you
   also configure an OpenAI-shaped transcription endpoint.

7. **Brave Search API key?** Optional. Skipped → `web_search` falls back to
   DuckDuckGo (no key).

8. **Web login password?** Optional. Skipped → web UI is open to anyone who can reach
   the port (front it with your own proxy if exposing publicly).

What comes up after the wizard exits:

```
daedalus      supervisor + scheduler           (long-running)
dae-worker    warm agent worker                (top-level turns)
graphiti      knowledge-graph memory MCP       (if SPARK_URL is set)
onecli + db   credential gateway + Postgres    (always)
whisper       local speech-to-text             (only with the `whisper` profile)
```

Tail the supervisor:

```bash
docker compose -f ~/.daedalus/compose/docker-compose.yml logs -f daedalus
```

Then talk to your agent through whichever channel you wired:

- **CLI:** run `dae serve` in another terminal and type into stdin.
- **Web:** open `http://127.0.0.1:8765` (the default; loopback-published so it's not
  exposed on your LAN — front it with your own reverse proxy to put it online).
- **Telegram:** message your bot.

### Linux / Ubuntu PATH note

After `npm install -g`, the `dae` binary lands in `$(npm config get prefix)/bin`.
On Ubuntu that directory is often not in `$PATH` by default. One-time fix:

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

## Managing secrets (`dae secret` → OneCLI)

API keys never live in the YAML config or the brain. They live in **OneCLI** — a
local HTTPS MITM proxy that injects the right header on outbound requests to the
right host. Agents only ever hold the placeholder string `onecli-managed`.

The `dae secret` family is the CLI on top of that vault.

### Day-to-day

```bash
# Store a key. Silent prompt — never appears in shell history.
dae secret save ANTHROPIC_API_KEY

# Or pass non-interactively (CI, scripts):
dae secret save ANTHROPIC_API_KEY -v sk-ant-…

# List names (never values):
dae secret list

# Pull a value to stdout (composable in shells):
dae secret get ANTHROPIC_API_KEY

# Remove:
dae secret delete ANTHROPIC_API_KEY

# Which backend is active and what can it do?
dae secret backend
```

### Registering a key for OneCLI injection

This is the form that tells OneCLI **which host + header** to inject the key into.
Once registered, agents reaching that host get the credential added on the wire.

```bash
dae secret save BRAVE_API_KEY \
    -u "api.search.brave.com/*" \
    -H "X-Subscription-Token" \
    -F "{value}"
```

- `-u <url-pattern>` — host (and optional path glob) the injection applies to
- `-H <header-name>` — HTTP header to add or replace
- `-F <format>` — value template; `{value}` is substituted with the secret

The Anthropic and OpenAI keys you supply to `dae install` get registered in exactly
this shape automatically — you only need the manual form for third-party API keys
your skills hit (Brave, GitHub, DigitalOcean, etc.).

### Why OneCLI, not just env vars

Secrets live in **one** place, rotate in one place, and never land in:

- the brain repo (which agents read)
- the YAML config (which is committable)
- agent system prompts (where the model can see them)
- logs

The supervisor and the warm worker fetch OneCLI's MITM CA at startup, trust it, and
route outbound HTTPS through the proxy. The agent's HTTP client carries
`onecli-managed`; OneCLI swaps it for the real key in flight.

See [docs/install.md](docs/install.md) for the full credential-resolution order
and how it interacts with `.env.local` fallbacks.

---

## Brain examples

The brain is a directory you point `brain.path` at — usually a separate git repo
sym-linked into `~/.daedalus/brain`. Run `dae init` to scaffold one from the example
that ships in [examples/brain/](examples/brain/):

```
brain/
├── agents/<name>.md            agent manifests (YAML frontmatter + body)
├── personas/<name>.md          persona prose injected per agent
├── souls/<name>.md             cross-cutting principles (e.g. "be careful")
├── standards/*.md              always-loaded; e.g. response-style rules
├── operations/*.md             always-loaded; e.g. workspace conventions
├── skills/<name>/SKILL.md      loadable capabilities (+ optional bootstrap.sh)
├── mcp/servers.json            MCP server configs (or a directory of *.json)
├── schedules/*.yaml            cron-driven agent invocations
└── memory/                     optional periodic memory snapshots
```

The shipped example covers:

| File | What it shows |
|---|---|
| [`agents/orchestrator.md`](examples/brain/agents/orchestrator.md) | The user-facing agent — picks subagents, all built-in tools |
| [`agents/coder.md`](examples/brain/agents/coder.md) | A specialist with its own container image (`node:24-alpine`) and a focused tool set |
| [`agents/researcher.md`](examples/brain/agents/researcher.md) | Read-only specialist with `web_search` + `web_fetch` |
| [`personas/*.md`](examples/brain/personas/) | One per agent; injected into the prompt under that agent's section |
| [`souls/careful.md`](examples/brain/souls/careful.md) | A cross-cutting principle composed into multiple agents |
| [`standards/response-style.md`](examples/brain/standards/response-style.md) | Always-loaded house style rules |
| [`skills/brave-search/SKILL.md`](examples/brain/skills/brave-search/SKILL.md) | Skill that requires a built-in tool + a secret |
| [`mcp/servers.json`](examples/brain/mcp/servers.json) | MCP server entries |
| [`schedules/daily-review.yaml`](examples/brain/schedules/daily-review.yaml) | A cron-driven invocation |

The system prompt is composed deterministically:

```
identity → standards → operations → souls → personas → skills → agent body → now
```

`identity` and `now` are auto-injected; everything else comes from your brain.

Full reference: [docs/agents.md](docs/agents.md).

---

## Setting up a new skill (including `bootstrap.sh`)

A **skill** packages a capability — instructions for the model plus an optional
install script for any binary it needs.

```
brain/skills/my-skill/
├── SKILL.md          frontmatter + instructions  (required)
└── bootstrap.sh      install script              (optional)
```

### `SKILL.md`

```markdown
---
description: "What this skill does — written to clearly signal WHEN to use it."
toolsRequired: [bash, web_fetch]   # built-in tools the skill leans on
requires:
  secrets: [MY_API_KEY]            # secrets that must resolve when the skill loads
---

Use this skill when you need X. Run `my-tool …` for the common case.
```

The `description` is critical — it's all the agent sees in the menu until it calls
`load_skill({ name: "my-skill" })`. Vague descriptions mean the agent never reaches
for the skill.

Full reference: [docs/skills.md](docs/skills.md).

### `bootstrap.sh`

Runs **once per content-hash** before the agent turn. Idempotent: a success marker
under `skill-bin/.bootstrap/` means subsequent runs are no-ops. Fast path:

```sh
#!/bin/sh
set -e
command -v my-tool >/dev/null 2>&1 && exit 0   # already installed → exit

# install into the per-skill scratch dir (persisted across container restarts)
PREFIX="$DAE_SKILL_BIN/npm-prefix"
mkdir -p "$PREFIX"
NPM_CONFIG_PREFIX="$PREFIX" npm install -g --no-audit --no-fund my-tool >&2

# expose via the shared PATH dir
ln -sf "$PREFIX/bin/my-tool" "$DAE_SKILL_PATH_DIR/my-tool"
```

Environment provided:

- `$DAE_SKILL_BIN` — per-skill scratch dir (npm prefixes, venvs, downloads).
- `$DAE_SKILL_PATH_DIR` — shared bin dir already on the agent's `PATH`.

### When the skill needs system libraries

`bootstrap.sh` runs **without root** — so it can `npm install`, `pip install --user`,
or download a static binary, but it **cannot** `apt-get install`. Anything that
needs a shared library (e.g. Chromium needs nss / GL / fonts; some Python wheels
need libssl-dev) must be **baked into the agent image**, not installed at runtime.

Two outcomes for a new skill that needs system libs:

1. **Use one of in-line.studio's default images** as the agent's `container.image`
   if it already has what you need (most do — they're designed for typical web /
   scripting workloads). Listed below.
2. **Build your own image** if no default fits — typically `FROM debian:bookworm-slim`
   plus an `apt-get install …` line. Point your agent's `container.image` at it.

The `agent-browser` skill is the worked example: Playwright + Chromium's system libs
are baked into the daedalus image so the skill's `bootstrap.sh` can do the
user-space part (download the Chromium binary into `$DAE_SKILL_BIN`).

### In-line.studio default images

The example brain references in-line.studio's per-stack agent images at
`ghcr.io/inline-studio/...`. These are designed for daedalus agents — glibc-based,
shell + git + jq + curl, ready for skill bootstraps. Browse them at
**[github.com/orgs/inline-studio/packages](https://github.com/orgs/inline-studio/packages)**
(may need access depending on visibility).

| Image | For agents that need |
|---|---|
| `ghcr.io/inline-studio/daedalus:latest` | The default — Node, Docker CLI, Chromium runtime libs. What the supervisor + warm worker run; also a fine default for general-purpose agents. |
| `ghcr.io/inline-studio/dev-node:latest` | Node-focused agents (extra Node versions via `n`, common build tooling) |
| `ghcr.io/inline-studio/dev-python:latest` | Python agents (CPython, pip, common scientific libs) |
| `ghcr.io/inline-studio/dev-php-8.3:latest` | PHP 8.3 agents (Composer, common PHP extensions) |

If these aren't accessible to you, the convention is straightforward — your own
image just needs a glibc-compatible base + a POSIX shell + whatever toolchain the
agent will reach for. See [docs/docker-mode.md](docs/docker-mode.md) for the agent
image contract.

---

## `dae` commands

### Top-level

| Command | What it does |
|---|---|
| `dae init` | Bootstrap `~/.daedalus/` from the shipped example |
| `dae install` | Turnkey: ensure config, then `docker compose up -d` the stack |
| `dae update` | Check for a newer release, install it, re-apply your configuration |
| `dae uninstall [--purge]` | Stop the stack (`--purge` also deletes config; data preserved) |
| `dae serve` | Long-running: channels + scheduler (what the supervisor container runs) |
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
docker compose up -d                        # start the stack
docker compose --profile whisper up -d      # also start local whisper STT
docker compose logs -f daedalus             # tail the supervisor
docker compose restart daedalus             # restart after a config change
docker compose up -d --build                # rebuild + restart after `dae update`
```

`restart: unless-stopped` on each service means the stack comes back on boot once
the Docker daemon starts.

---

## Deeper documentation

For everything beyond the surface, the [`docs/`](docs/README.md) tree has the
detail:

- [`docs/install.md`](docs/install.md) — installation, providers, Brave, memory, OneCLI, the Docker choice
- [`docs/agents.md`](docs/agents.md) — agent manifests, frontmatter reference, container settings
- [`docs/skills.md`](docs/skills.md) — building skills, `bootstrap.sh` contract, the daedalus image
- [`docs/channels.md`](docs/channels.md) — Telegram, inbound / outbound attachments
- [`docs/mcp.md`](docs/mcp.md) — MCP server configuration
- [`docs/docker-mode.md`](docs/docker-mode.md) — dispatch architecture, per-agent mounts, SSH key auto-mount

---

## Testing

```bash
npm test                                  # CI-safe + CLI-spawning smokes (default outside CI)
DAE_TEST_SCOPE=ci npm test                # CI-only subset; what GitHub Actions runs
DAE_TEST_SCOPE=all npm test               # everything including Docker-dependent tests
```

## License

MIT (placeholder).
