# Daedalus

> An SDK-agnostic agent runner. CLI: `dae`.

Daedalus is the platform; **your assistant is whatever you name it** (default `Artemis`).
The two are deliberately separated — Daedalus is the architecture; the persona is the
character that performs on it.

[![CI](https://github.com/inline-studio/daedalus/actions/workflows/ci.yml/badge.svg)](https://github.com/inline-studio/daedalus/actions/workflows/ci.yml)

## Why

Most agentic tools today are tightly coupled to a single LLM provider, a single channel,
and a single persona — and dump configuration wherever convenient. Daedalus inverts all
three:

- **Provider-agnostic** — Anthropic, OpenAI, Ollama, vLLM, llama.cpp, LiteLLM gateway,
  anything OpenAI-shaped. Change the agent manifest, not the runner.
- **Brain-repo driven** — your agents, personas, souls, standards, operations, skills,
  MCP servers, and schedules live in a separate git repo. Sym-link it into Claude Code,
  VS Code, OpenCode — same files, same vault, multiple frontends.
- **Persona/runtime separation** — your assistant is whatever name you set
  (`dae identity Claudia`). Subagents stay invisible behind it. Daedalus is the platform,
  not the assistant.
- **Channel-unified** — talk to your assistant from CLI, web, Telegram, WhatsApp.
  All channels share one session per user; conversation continues across surfaces.
- **Per-agent containers** — give a coder agent `node:24-alpine`, a php agent `php:8-cli`.
  Tool execution runs in the right runtime; brain repo auto-mounted read-only.
- **Real memory** — MemPalace MCP backend for verbatim, vector-searchable conversation
  storage. Run it locally as stdio, locally as HTTP, or remotely on a server you point
  every device at.
- **Reversible setup** — every `dae setup <thing>` has a matching `dae disable <thing>`,
  with idempotent default + `--purge` for clean slate.

## Status

Pre-alpha (v0.1). Core abstractions, channels, sessions, attachments, web tools, secrets,
services, identity, and the orchestrator/subagent ask-user bubble-up are wired and
smoke-tested across **14 smoke suites** covering ~150 assertions. See
[scripts/test.mjs](scripts/test.mjs) and the GitHub Actions workflow.

## Documentation

Full guides live in [`docs/`](docs/README.md):

- [Installation & integrations](docs/install.md) — `dae install`, providers, Brave,
  memory, OneCLI, the Docker choice
- [Agents & the brain](docs/agents.md) — creating/customising agents, frontmatter reference
- [Skills](docs/skills.md) — building skills, the install script, the daedalus image
- [Channels](docs/channels.md) — Telegram, inbound/outbound attachments
- [MCP servers](docs/mcp.md) — one file per server, auto-merge
- [Docker mode](docs/docker-mode.md) — the dispatch architecture

## Install

```bash
npm install -g https://github.com/inline-studio/daedalus/releases/latest/download/daedalus-latest.tgz
dae --version
```

Both `dae` and `daedalus` are installed as aliases — use whichever reads better.

Once installed, keep it current with:

```bash
dae update
```

### Clone for development

```bash
git clone git@github.com:inline-studio/daedalus.git
cd daedalus
npm install
npm run link:cli       # build + npm link in one step; both `dae` and `daedalus` go global
```

### Linux / Ubuntu — PATH note

After `npm install -g`, the `dae` binary lands in `$(npm config get prefix)/bin`. On
Ubuntu that directory is often not in `$PATH` by default. One-time fix:

```bash
mkdir -p ~/.npm-global
npm config set prefix '~/.npm-global'
echo 'export PATH="$HOME/.npm-global/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

Then re-run the install command and `dae --version` should work.

### Prerequisites

- **Node.js 24+** (LTS). Daedalus uses `node:sqlite` and other 24-era APIs.
- **Docker + the compose plugin** — required. The whole stack (supervisor + scheduler,
  memory, and optional whisper STT) runs as containers (see `docs/docker-mode.md`).

## Quickstart

```bash
dae install                 # the turnkey command: see below
```

`dae install` is a thin wrapper around `docker compose`. It makes sure a config
exists, asks the few things it can't infer, writes the config + the compose `.env`,
then runs `docker compose up -d` to bring up the whole stack:

```
daedalus    supervisor + scheduler
mempalace   shared memory (always)
onecli      credential gateway + its postgres (always)
whisper     local speech-to-text (only if you opt in)
```

The questions: **local whisper?** (yes/no), **Telegram bot token?** (optional),
**memory auth token?** (optional), **OneCLI API key?** (optional — blank runs OneCLI
disabled for now). Everything else is read from your config; re-running picks up the
previous answers ("leave blank to keep").

(Per-tool API keys like Brave Search and your LLM provider key live in OneCLI, not in
daedalus — `dae install` registers them so the gateway injects them at the proxy edge.)

Once the stack is up, talk to your agent through a channel (Telegram/Web), or follow the
supervisor with `docker compose logs -f daedalus`.

## Concepts

### The brain repo

A directory (often a separate git repo, sym-linked) with this layout:

```
brain/
├── agents/<name>.md         agent manifests (YAML frontmatter + body)
├── personas/<name>.md       persona prose injected per agent
├── souls/<name>.md          cross-cutting principles (e.g. "be careful")
├── standards/*.md           always-loaded; e.g. response-style rules
├── operations/*.md          always-loaded; e.g. workspace conventions
├── skills/<name>/SKILL.md   loadable capabilities; declare required secrets, tools
├── mcp/servers.json         MCP server configs (or a directory of *.json)
├── schedules/*.yaml         cron-driven agent invocations
└── memory/                  optional periodic memory snapshots from mempalace
```

Daedalus composes the system prompt deterministically:

```
identity → standards → operations → souls → personas → skills → agent body → now
```

The `identity` and `now` blocks are auto-injected — the rest comes from your brain.

### Identity vs persona

The user-facing assistant has **one** name (`identity.name` in config, default `Artemis`).
Subagents are invisible to the user — when they ask questions, they bubble up via the
`ask_user` tool, the orchestrator phrases the question in the persona's voice, the user
answers, and the orchestrator routes the answer back. From the user's perspective, only
one thing is talking to them.

### Channels are not groups

Telegram, WhatsApp, web, CLI — every channel publishes into the same per-user session
keyed by `(user_id, agent_name)`. Reach your assistant from your phone over Telegram,
then later from VS Code over MCP — same conversation history, no partitioning.

### Configuration resolution

Three places config can live; Daedalus picks the first that exists:

1. `-c <path>` flag
2. `DAE_CONFIG` env var
3. `./daedalus.config.yaml` (or `.yml` / `.json`) in cwd
4. `~/.daedalus/config.yaml` (per-user fallback)

Same logic for `.env` / `.env.local`: cwd wins, then `<configDir>/.env.local`.

### Secret resolution

Provider API keys are NEVER stored in the YAML. Resolution order at agent start:

1. `providers.<provider>.apiKey` (escape hatch; explicit override)
2. `process.env[<CANONICAL_NAME>]` (shell, dotenv)
3. `SecretsBackend.get(<NAME>)` (env-file or OneCLI vault)
4. If `onecli.enabled: true` — placeholder sent; OneCLI's gateway swaps the real key
   in at the network edge

If none resolve, the runner refuses to start with a fix-it message that lists every
way to provide the missing key.

## CLI reference

### Top-level

```
dae init                            Bootstrap ~/.daedalus/ from the shipped example
dae install                         Turnkey: ensure config, then `docker compose up -d` the stack
dae uninstall [--purge]             Stop the stack (--purge also deletes config; data preserved)
dae update                          Update the CLI, then rebuild + restart the containers
dae serve                           Long-running: channels + scheduler (what the container runs)
dae agents | skills | mcp           Browse what's in the brain
dae config                          Print resolved config as JSON
dae identity [name] [--nickname]    Show or change the orchestrator's persona name
dae export mempalace [--host]       Print paste-ready MCP snippet for other devices
```

### Setup / disable (every setup has a symmetric disable)

```
dae setup                                   Interactive guided wizard (default)
dae setup [telegram|whatsapp|search|onecli|mempalace|whisper]
dae setup --list

dae disable <thing>                         Idempotent: flips toggles off; secrets preserved
dae disable <thing> --purge [--yes]         Clean slate: removes config + secrets
dae disable --list
```

### Secrets

```
dae secret save <NAME>                      Silent prompt; or use -v to pass non-interactively
dae secret save <NAME> -u <pattern> -H <header> -F <format>
                                            OneCLI mode: also store url-pattern + injection
dae secret get <NAME>                       Stdout-clean (composable in shells)
dae secret list                             Names only, never values
dae secret delete <NAME>
dae secret backend                          Which backend, what capabilities
```

### Running as a service (docker compose)

The stack runs as containers — there is no host systemd/launchd unit to install.
`dae install` writes a `.env` next to `docker-compose.yml` and brings everything up;
manage it afterwards with plain compose:

```
dae install                                 Write config + .env, then `docker compose up -d`
dae uninstall                               `docker compose down` (--purge also: -v + delete config)

docker compose up -d                        Start the stack (daedalus + mempalace)
docker compose --profile whisper up -d      Also start local whisper STT
docker compose logs -f daedalus             Tail the supervisor
docker compose restart daedalus             Restart after a config change
docker compose up -d --build                Rebuild + restart after `dae update`
```

`restart: unless-stopped` on each service means the stack comes back on boot once the
Docker daemon starts — no linger/loginctl dance.

## Configuration reference (annotated)

```yaml
# ~/.daedalus/config.yaml
brain:
  path: ./brain # absolute or relative to this config file
  writable: false # BRAIN_WRITABLE=1 lets agents self-modify skills/personas

identity:
  name: Artemis # the user-facing persona; configurable per machine

providers:
  # API keys do NOT live here — see "Secret resolution" above.
  openai:
    baseUrl: https://litellm.in-line.studio/v1 # or any OpenAI-compatible URL
  # anthropic: {}
  # ollama:
  #   baseUrl: http://localhost:11434

runtime:
  dispatcher: container # agents run as docker containers (the supported deployment)
  shared:
    enabled: true
    hostPath: ./data/shared # writable cross-agent persistent storage
    containerPath: /shared # exposed to bash via $DAE_SHARED

onecli:
  enabled: false
  proxy: http://localhost:10255

secrets:
  backend: auto # 'auto' | 'onecli' | 'env-file'
  envFile: { path: .env.local }
  onecli: { baseUrl: http://localhost:10254 }

mcp:
  configPath: ./brain/mcp/servers.json # file or directory of *.json

memory:
  backend: none # 'mempalace' to enable
  brainSync:
    enabled: false
    schedule: "0 */6 * * *"

mempalace:
  # When localHttp.enabled is true, daedalus auto-injects an MCP server named
  # `memory` (→ this host:port) into EVERY agent. NOTE: this auto-inject is
  # suppressed if an MCP server named `memory` OR `mempalace` already exists in
  # your `mcp:` config — an explicit def overrides the built-in. To rely on the
  # built-in, don't define one (and remove any leftover brain/mcp/memory.json).
  localHttp: # only used when you ran `dae setup mempalace` in local-http mode
    enabled: false
    command: uvx
    args: [mempalace-mcp]
    host: 127.0.0.1
    port: 11364
    urlPath: /mcp

channels:
  cli:
    enabled: true
    defaultAgent: orchestrator
  # web | telegram | whatsapp also supported

transcribe:
  backend: none # 'openai-whisper' for OpenAI or any local server speaking the same shape
  baseUrl: https://api.openai.com/v1 # must include /v1
  model: whisper-1

web:
  search:
    provider: duckduckgo # 'none' | 'duckduckgo' (no key) | 'brave' (apiKey required)
  fetch:
    maxBytes: 1000000
    timeoutMs: 20000
```

## Common workflows

### Set up Telegram

```bash
dae setup telegram           # paste the BotFather token, pick which agent handles inbounds
docker compose up -d         # (or `dae install`) — the supervisor long-polls Telegram
```

`dae install` also asks for a Telegram token directly, so this is only needed when
adding/changing the bot after the initial install.

### Shared MemPalace memory, accessible from your laptop

MemPalace runs as the `mempalace` compose service (loopback-published on `:11364`).
Other devices can point their MCP client at it:

```bash
dae export mempalace             # prints the paste-ready MCP snippet (+ token if auth is on)

# Copy the snippet into every device that needs the same memory:
#   - Claude Desktop:  ~/Library/Application Support/Claude/claude_desktop_config.json
#   - VS Code MCP:     .vscode/mcp.json
#   - OpenCode:        ~/.config/opencode/mcp.json
```

### Switch your assistant's name

```bash
dae identity                 # show current
dae identity Claudia --nickname Claud
```

System prompt picks up the change on the next agent run. Subagents see Claudia as the
user-facing persona and route their questions accordingly.

### Wire OneCLI for credential injection

OneCLI runs in the stack (the `onecli` + `onecli-db` services). `dae install` asks for
its daemon API key and enables it; supply the key there, or wire it afterwards:

```bash
dae setup onecli             # probes the loopback-published onecli, validates, persists config
dae secret save BRAVE_API_KEY \
    -u "api.search.brave.com/*" \
    -H "X-Subscription-Token" -F "{value}"
# Now agents send a placeholder; OneCLI swaps the real key in at the proxy edge.
```

## Architecture sketch

```
┌─────────────────────────────────────────────────────────────────────────┐
│  channels  cli, web (HTTP+SSE), telegram (long-poll), whatsapp (graph)  │
└──────────────────────────────────┬──────────────────────────────────────┘
                                   │ IncomingMessage (cross-channel
                                   │  unified by user_id; SQLite sessions)
                            ┌──────▼──────┐
                            │  bus + run  │  per-(user, agent) session
                            └──────┬──────┘
                                   │ Message[]
              ┌────────────────────▼────────────────────┐
              │  Kernel — provider-agnostic agent loop  │
              │   • complete → tool_use → execute       │
              │   • catches AskUserSignal for subagents │
              └─┬──────────────────┬──────────────────┬─┘
                │                  │                  │
       ┌────────▼─────┐    ┌───────▼──────┐    ┌──────▼─────┐
       │  Provider    │    │ ToolRegistry │    │ MCP client │
       │  adapters    │    │   bash, web, │    │  stdio /   │
       │ Anthropic /  │    │ file, attach,│    │  http/SSE  │
       │  OpenAI*/    │    │ ask_user,    │    │  (mempalace│
       │  Ollama      │    │ spawn_subagt │    │   etc.)    │
       └──────────────┘    └──────┬───────┘    └────────────┘
                                  │ ToolContext
                          ┌───────▼──────┐
                          │   Runtime    │
                          │ in-container │
                          │  + shared FS │
                          └──────────────┘

      [identity, brain composer, time-awareness, secret resolution all happen
       at run setup, before the first kernel turn]
```

## Testing

```bash
npm test                                  # CI-safe smokes (default outside CI)
DAE_TEST_SCOPE=ci npm test                # CI-only subset; what GitHub Actions runs
DAE_TEST_SCOPE=local npm test             # default outside CI
DAE_TEST_SCOPE=all npm test               # everything including Docker-needed tests
```

Test scopes are defined in [scripts/test.mjs](scripts/test.mjs):

- **ci** — pure unit/wiring; no Docker daemon, no live LLM
- **local** — also runs the CLI-spawning smokes
- **all** — also runs Docker-dependent tests (`smoke-shared`, `smoke-agent-container`)

## Releases

Merging to main triggers [.github/workflows/ci.yml](.github/workflows/ci.yml),
which:

1. Runs the CI test suite
2. `npm run build`
3. `npm pack` → `daedalus-<version>.tgz`
4. Uploads as a GitHub Release artifact

Users install with `npm install -g <release-tarball-url>`.

## Contributing / development

```bash
git clone git@github.com:inline-studio/daedalus.git
cd daedalus-
npm install                                 # also runs `prepare` → builds dist/
npm run link:cli                            # build + global link
npm test                                    # smoke battery
```

Hot-iterate without rebuilding via `tsx`:

```bash
npm run dev -- run orchestrator --prompt "..."
```

## License

MIT (placeholder).
