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
6. **Memory token** — set a bearer token for the memory store. (Optional. The memory
   server itself enforces nothing — internally it's reached over the private docker
   network — so a token only matters if you expose memory through a reverse proxy that
   checks it. See [docker-mode.md](./docker-mode.md) → "Exposing memory to other devices".)
7. **Timezone** — IANA zone (e.g. `Europe/London`) for scheduling and timestamps,
   defaulting to the host's detected zone → written as `TZ` in the compose `.env`. The
   containers default to UTC without it, which skews fired schedules and the local time
   agents see. An update asks once if your existing `.env` has no `TZ` yet.

Everything else is automatic: OneCLI, the memory store, and the warm agent worker always
run. Re-running is idempotent ("leave blank to keep" reuses previous answers).

Then it runs `docker compose up -d --build`, bringing up:

| Container | Role |
|---|---|
| `daedalus` | Supervisor + scheduler (`dae serve`) — owns the channels. |
| `dae-worker` | Warm agent worker — runs top-level agent turns without per-message boot. |
| `graphiti` | Shared memory — a temporal knowledge-graph MCP every agent gets (with the `graphiti` profile, enabled when an OpenAI-compatible endpoint is configured). |
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

### Registering a third-party key for injection

`dae install` auto-registers the Anthropic, OpenAI, and Brave keys in the right
host+header shape. For any *other* third-party API your skills hit (GitHub,
DigitalOcean, …), register the injection manually with `dae secret save`:

```bash
dae secret save BRAVE_API_KEY \
    -u "api.search.brave.com/*" \
    -H "X-Subscription-Token" \
    -F "{value}"
```

- `-u, --url-pattern <pattern>` — host (and optional path glob) the injection applies to.
- `-H, --header-name <name>` — HTTP header to add or replace (e.g. `Authorization`).
- `-F, --value-format <fmt>` — value template; `{value}` is substituted with the secret
  (e.g. `Bearer {value}`).
- `-a, --agent <name>` — optionally scope the injection to a single agent.

Once registered, any agent reaching that host gets the credential added on the wire; the
runner only ever holds the placeholder `onecli-managed`. The other `dae secret` commands
(`get`, `list`, `delete`, `backend`) are in the [README](../README.md#dae-commands).

## Brave (web search)

If you provide a Brave key, `dae install` sets `web.search.provider: brave` (with the
placeholder `apiKey: onecli-managed`) and registers the real key in OneCLI, injected into
`api.search.brave.com` as `X-Subscription-Token`. Skip it to fall back to DuckDuckGo
(no key). Agents use it via the `web_search` built-in tool.

## Memory

Memory is a **Graphiti** container — a temporal knowledge-graph MCP server, auto-injected as
the `memory` server for every agent (see [mcp.md](./mcp.md)). Its extraction LLM + embeddings
run on your OpenAI-compatible endpoint, reached through the OneCLI proxy (so the key never hits disk). The
graph store is a persistent bind-mount (`GRAPHITI_DATA_PATH`), so memories survive restarts and
the whole store is portable to another host. See [docker-mode.md](./docker-mode.md) → "The
`graphiti` container" for details.

### Picking an embeddings setup

Graphiti needs a capable INSTRUCT model (to extract entities + relationships from each turn)
**and** an embeddings model (for semantic recall), both reachable via an OpenAI-shaped API at
one base URL (`OPENAI_BASE_URL`). At install `dae install` asks for the **extraction model
name**, the **embeddings model name**, and the **embeddings dimension** — there's no magic
default model id, so the names must be ones that actually exist on your endpoint. The
dimension MUST match your embeddings model. The shipped defaults are conventional OpenAI ids
(`gpt-4o-mini`, `text-embedding-3-small`, dim `1536`) so plain OpenAI works on Enter-through.
The clean setups:

- **OpenAI-only** — the shipped defaults: extraction `gpt-4o-mini`, embeddings
  `text-embedding-3-small` (1536 dims), `GRAPHITI_EMBED_DIM=1536`.
- **LiteLLM in front of multiple providers** — front Anthropic for the extraction LLM *and*
  OpenAI (or a local server) for embeddings under a single base URL, then give `dae install`
  the model aliases your gateway exposes. Point `OPENAI_BASE_URL` at the gateway, e.g.
  `https://litellm.example.com/v1`.
- **Fully local** — [Ollama](https://ollama.com) serves both. `ollama pull nomic-embed-text`
  gives 768-dim embeddings, so set the embeddings model to `nomic-embed-text` and
  `GRAPHITI_EMBED_DIM=768`.
- **Anthropic + a separate embeddings endpoint** — Anthropic for the chat model on one
  provider entry; a small Ollama/local container for embeddings under `OPENAI_BASE_URL`.
  Anthropic ships no embeddings API, so memory always needs an embeddings endpoint *somewhere*.

If you don't want memory, skip the endpoint/`OPENAI_BASE_URL` answer at install — the
`graphiti` profile stays disabled and no embeddings model is needed.

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
