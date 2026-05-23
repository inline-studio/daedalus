# Installation & integrations

Daedalus runs as a small **docker-compose stack**. `dae install` is the one turnkey
command — it ensures a config exists, asks the few things it can't infer, writes the
compose `.env`, and brings the whole stack up.

## Prerequisites

- Docker (with the compose plugin).
- A brain directory (`dae init` scaffolds one from the example, or point `brain.path` at
  your own).

## `dae install`

```
dae install
```

It asks only what can't be inferred:

1. **Anthropic** — "will any agent use Claude directly?" → captures `ANTHROPIC_API_KEY`.
2. **OpenAI-compatible** — "OpenAI / LiteLLM / vLLM / Ollama?" → captures the base URL +
   key.
3. **Local Whisper** — run a Whisper container for voice-note transcription? (optional)
4. **Telegram** — your `@BotFather` bot token. (optional, but the primary channel)
5. **Brave** — a Brave Search API key for `web_search`. (optional; otherwise DuckDuckGo)
6. **Memory auth** — require a bearer token on the memory server?

Everything else is automatic: OneCLI, the memory store, and the warm agent worker always
run. Re-running is idempotent ("leave blank to keep" reuses previous answers).

Then it runs `docker compose up -d --build`, bringing up:

| Container | Role |
|---|---|
| `daedalus` | Supervisor + scheduler (`dae serve`) — owns the channels. |
| `dae-worker` | Warm agent worker — runs top-level agent turns without per-message boot. |
| `mempalace` | Shared memory store (an MCP server every agent gets). |
| `onecli` (+ `onecli-db`) | Credential-injecting gateway (+ its Postgres). |
| `whisper` | Local speech-to-text — only with the `whisper` profile (if you opted in). |

Each inbound message is handled by the warm worker; subagents spawn their own short-lived
containers. See [docker-mode.md](./docker-mode.md) for the dispatch architecture.

## LLM providers (OpenAI & Anthropic)

The **provider is chosen per agent** (the agent's `provider:` + `model:` — see
[agents.md](./agents.md)), not globally. The config's `providers:` block only supplies
the base URL and resolves the key for whichever provider an agent picks. You can use both
at once — different agents, different providers.

**Keys never live in the brain or on disk.** At agent start, a key resolves in order:

1. `providers.<provider>.apiKey` in the config (advanced; not recommended for real keys)
2. `process.env` (shell / `.env.local`)
3. the secrets backend
4. **OneCLI** — the agent sends the placeholder `onecli-managed` and OneCLI swaps in the
   real key at the network edge

`dae install` wires path 4: it registers your keys **in OneCLI**, scoped to the right
host + header:

- Anthropic → injected into `api.anthropic.com` as `x-api-key`.
- OpenAI-compatible → injected into your base-URL host as `Authorization: Bearer …`
  (also writes `providers.openai.baseUrl` so agents route there — e.g. your LiteLLM).

So an agent's outbound LLM call carries a placeholder; OneCLI injects the real secret in
flight. The runner never sees it.

## OneCLI (the credential model)

OneCLI is an HTTPS **MITM credential gateway**. At startup the supervisor/worker fetch its
container-config bundle (proxy URL + MITM CA), route outbound HTTPS through the proxy, and
trust the CA. For requests to a host OneCLI has a secret for, it **injects the credential
on the wire** — the agent only ever holds a placeholder.

Why this matters: secrets live in **one** place, rotate in one place, and never land in
the brain, the config, agent prompts, or logs. In the stack, OneCLI runs in **local
mode** (open API on the private `daedalus` network); `dae install` generates a stable
daemon key and registers your keys for you. (Subprocess tooling like `npm`/`curl`/`gh`
goes *direct*, not through the proxy — see [skills.md](./skills.md).)

## Brave (web search)

If you provide a Brave key, `dae install` sets `web.search.provider: brave` (with the
placeholder `apiKey: onecli-managed`) and registers the real key in OneCLI, injected into
`api.search.brave.com` as `X-Subscription-Token`. Skip it to fall back to DuckDuckGo
(no key). Agents use it via the `web_search` built-in tool.

## Memory

Memory is a **mempalace** container fronted as an HTTP MCP server, auto-injected as the
`memory` server for every agent (see [mcp.md](./mcp.md)). The on-disk "palace" is a
persistent bind/volume, so memories survive restarts. Optionally protected by a bearer
token (`MEMPALACE_TOKEN`), which the supervisor forwards into agents.

## Why all-container (the Docker choice)

The supported deployment is **everything in containers** — there is no host service to
install. The reasons:

- **Isolation.** Each agent turn (and each subagent) runs in its own container with a
  scoped mount set, not on your host. Untrusted, model-generated `bash` stays sandboxed.
- **Reproducibility.** `dae install` packs your *exact* installed CLI into the image, so
  the running image always matches your `dae` version — no drift against a published
  release.
- **Turnkey.** One command brings up the supervisor, worker, memory, and credential
  gateway together, wired on a private network where they reach each other by name.
- **Portability.** A single config works for host-side commands and inside the container
  (path remapping handles `/brain`, `/data`, `/shared`).

Deep dive: [docker-mode.md](./docker-mode.md).

## Updating & uninstalling

- `dae update` — fetch the latest release, reinstall the CLI, and rebuild + restart the
  containers from the new version (reusing your existing `.env`, no re-prompting).
- `dae uninstall` — stop the stack (`docker compose down`). Your data volumes are
  preserved; `--purge` also removes the config/`.env`.
