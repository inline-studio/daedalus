# Daedalus

> An SDK-agnostic agent runner. CLI: `dae`.

Daedalus is the platform; **your assistant is whatever you name it** (default `Artemis`).
The two are deliberately separated — Daedalus is the architecture; the persona is the
character that performs on it.

[![test](https://github.com/inline-studio/daedalus-/actions/workflows/test.yml/badge.svg)](https://github.com/inline-studio/daedalus-/actions/workflows/test.yml)

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

## Install

### Option A — install the released CLI

```bash
# Latest release (substitute the version):
npm install -g https://github.com/inline-studio/daedalus-/releases/download/v0.1.0/daedalus-0.1.0.tgz

dae --version
```

`dae` and `daedalus` are both installed (same binary). Use whichever reads better.

### Option B — install directly from git

```bash
npm install -g github:inline-studio/daedalus-
# or pin a tag/branch:
npm install -g github:inline-studio/daedalus-#main
```

The `prepare` lifecycle hook runs `npm run build` automatically, so the bin is ready
to call right after install.

### Option C — clone for development

```bash
git clone git@github.com:inline-studio/daedalus-.git
cd daedalus-
npm install
npm run link:cli       # build + npm link in one step; both `dae` and `daedalus` go global
```

### Prerequisites

- **Node.js 24+** (LTS). Daedalus uses `node:sqlite` and other 24-era APIs.
- **Docker** — only if you want per-agent containers; not required for stdio/host mode.
- **uv or pipx** — only if you set up local-stdio mempalace or local whisper.

## Quickstart

```bash
dae init                    # creates ~/.daedalus/config.yaml + a starter brain
dae setup                   # interactive wizard for integrations (yes/skip/stop per item)
dae service install         # multi-select wizard to run things as systemd/launchd services
dae run orchestrator --prompt "hello"
```

For first-time setup of everything in one flow:

```bash
dae install                 # init (if needed) → setup wizard → service install wizard
```

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
dae install                         One-shot: init + setup wizard + service install wizard
dae run <agent> --prompt "..."      Run an agent once
dae serve                           Long-running: channels + scheduler
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

### Services (Linux/WSL → systemd, macOS → launchd)

```
dae service install                         Interactive multi-select wizard (default)
dae service install <name>                  Just one
dae service install --all                   Non-interactive: every spec
dae service install --dry-run               Preview the unit, no writes
dae service uninstall [name|--all]
dae service start | stop | restart | status [name]
dae service logs [name]                     Prints the platform tail-logs command
dae service install --list                  Available specs (daedalus, whisper, mempalace)
```

User services stop on logout. To survive logout / start at boot, run once:
- systemd: `sudo loginctl enable-linger $USER`
- launchd: move the plist into `/Library/LaunchDaemons/` (needs sudo)

## Configuration reference (annotated)

```yaml
# ~/.daedalus/config.yaml
brain:
  path: ./brain          # absolute or relative to this config file
  writable: false        # BRAIN_WRITABLE=1 lets agents self-modify skills/personas

identity:
  name: Artemis          # the user-facing persona; configurable per machine

providers:
  # API keys do NOT live here — see "Secret resolution" above.
  openai:
    baseUrl: https://litellm.in-line.studio/v1   # or any OpenAI-compatible URL
  # anthropic: {}
  # ollama:
  #   baseUrl: http://localhost:11434

runtime:
  default: host          # 'host' or 'docker'
  shared:
    enabled: true
    hostPath: ./data/shared    # writable cross-agent persistent storage
    containerPath: /shared     # exposed to bash via $DAE_SHARED

onecli:
  enabled: false
  proxy: http://localhost:10255

secrets:
  backend: auto          # 'auto' | 'onecli' | 'env-file'
  envFile: { path: .env.local }
  onecli: { baseUrl: http://localhost:10254 }

mcp:
  configPath: ./brain/mcp/servers.json   # file or directory of *.json

memory:
  backend: none          # 'mempalace' to enable
  brainSync:
    enabled: false
    schedule: '0 */6 * * *'

mempalace:
  localHttp:             # only used when you ran `dae setup mempalace` in local-http mode
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
  backend: none          # 'openai-whisper' for OpenAI or any local server speaking the same shape
  baseUrl: https://api.openai.com/v1   # must include /v1
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
dae setup telegram
# paste the BotFather token, pick which agent handles incoming messages
dae serve            # the runner long-polls Telegram and routes to the orchestrator
```

### Set up shared MemPalace on a server, accessible from your laptop

```bash
# On the server:
dae setup mempalace          # pick "local-http", bind to 0.0.0.0, choose a port
dae service install mempalace    # systemd unit; survives logout with enable-linger
dae export mempalace             # prints the paste-ready MCP snippet + token

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

```bash
dae setup onecli             # probes localhost:10254 + 10255, validates, persists config
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
                          │  host/docker │
                          │  + shared FS │
                          └──────────────┘

      [identity, brain composer, time-awareness, secret resolution all happen
       at run setup, before the first kernel turn]
```

## Testing

```bash
npm test                                  # CI-safe smokes (default outside CI: also tries
                                          # systemd/launchd integration tests)
DAE_TEST_SCOPE=ci npm test                # CI-only subset; what GitHub Actions runs
DAE_TEST_SCOPE=local npm test             # default outside CI
DAE_TEST_SCOPE=all npm test               # everything including Docker-needed tests
```

Test scopes are defined in [scripts/test.mjs](scripts/test.mjs):

- **ci** — pure unit/wiring; no Docker daemon, no systemd-user, no live LLM
- **local** — also runs service-install end-to-end (degrades gracefully on Windows)
- **all** — also runs Docker-dependent tests (`smoke-shared`, `smoke-agent-container`)

## Releases

Tags matching `v*` trigger [.github/workflows/release.yml](.github/workflows/release.yml),
which:

1. Runs the CI test suite
2. `npm run build`
3. `npm pack` → `daedalus-<version>.tgz`
4. Uploads as a GitHub Release artifact

Users install with `npm install -g <release-tarball-url>`.

## Contributing / development

```bash
git clone git@github.com:inline-studio/daedalus-.git
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
