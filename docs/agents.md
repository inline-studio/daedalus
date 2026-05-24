# Agents & the brain

Daedalus separates **what your agents are** (the *brain* — declarative markdown you
own and version) from **the engine that runs them** (daedalus itself). You never edit
daedalus to change behaviour; you edit the brain.

## Why this shape

- **Declarative, portable agents.** An agent is a markdown file with YAML frontmatter.
  Its persona, behaviour, tools, and model are data — diff-able, reviewable, swappable.
  The brain is its own directory (often its own git repo), delivered separately from the
  daedalus image, so you can iterate on agents without rebuilding anything.
- **Composition over copy-paste.** Shared behaviour lives in reusable sections
  (`souls`, `personas`, `standards`, `operations`, `skills`) that any agent pulls in.
  Change a soul once; every agent that uses it updates.
- **A team, not one monolith.** One user-facing **orchestrator** delegates to focused
  **subagents** (a coder, a reviewer, a researcher…). Each stays small and good at one
  thing; the orchestrator routes and summarises. This keeps prompts tight and lets you
  grow capability by adding agents, not by bloating one.
- **Isolation by default.** Each agent turn runs in a container (see
  [docker-mode.md](./docker-mode.md)). The supported deployment is all-container.

## Brain layout

```
brain/
  agents/        <name>.md         one file per agent (frontmatter + body)
  souls/         *.md              voice / disposition (shared)
  personas/      *.md              role framing (shared)
  standards/     *.md              cross-cutting rules (style, safety…)
  operations/    *.md              operational playbooks
  skills/        <name>/SKILL.md   capabilities (+ optional bootstrap.sh) — see skills.md
  commands/      <name>.md         slash-commands (e.g. /ship)
  mcp/           *.json            MCP servers — see mcp.md
  schedules/     *.yaml            cron-style scheduled prompts
  memory/                          (optional) brain-synced memory
```

`brain.path` in `daedalus.config.yaml` points here; it's mounted read-only into every
agent container.

## Creating an agent

Add `brain/agents/<name>.md`. The filename is the agent's name (referenced by channels'
`defaultAgent` and by `subagents:` lists). Frontmatter configures it; the markdown body
below the `---` is that agent's own system-prompt segment.

```markdown
---
name: researcher
description: "Finds and summarises information from the web."
provider: openai
model: gpt-4o
tools: [web_search, web_fetch, read, write]
skills: [brave-search]
souls: [careful]
---

You are a thorough researcher. Cite sources. Prefer primary sources over summaries.
```

## Frontmatter reference

Only **`provider`** and **`model`** are required. Everything else is optional — the
**Type — default** column shows what you get when you omit it. (`name` is taken from the
filename, so any value set in frontmatter is ignored.)

| Field | Required | Type — default | What it does |
|---|---|---|---|
| `name` | — | string | Agent id. Taken from the **filename**; a frontmatter value is ignored. |
| `description` | No | string — `""` | One-liner; shown in the orchestrator's `spawn_subagent` menu. |
| `provider` | **Yes** | `anthropic` \| `openai` \| `ollama` | Which LLM API to call. Decides the wire protocol and which key resolves (see [install.md](./install.md)). `openai` covers any OpenAI-compatible endpoint (OpenAI, LiteLLM, vLLM, Ollama `/v1`…). |
| `model` | **Yes** | string | Model id passed to the provider (e.g. `claude-sonnet-4-6`, `gpt-4o`, or a LiteLLM alias). |
| `maxTurns` | No | int — `50` | Max tool-use iterations in one turn before the loop stops. |
| `maxTokens` | No | int — `4096` | Max output tokens per LLM call. |
| `temperature` | No | 0–2 — provider default | Sampling temperature; omit for the provider default. |
| `vision` | No | bool \| string — `false` | Image input. `false`/omit = inbound images aren't sent to the model. `true` = the agent's own `model` is multimodal. `"provider/model"` = describe images via that separate vision model, then the main `model` answers. See below. |
| `tools` | No | string[] — `[]` | Built-in tools the agent may use: `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`, `schedule_message`, … `['*']` = all. **Empty = none** (the safe default for subagents). |
| `skills` | No | string[] — `[]` | Skills from `brain/skills/`. `['*']` = every skill. See [skills.md](./skills.md). |
| `mcpServers` | No | string[] — `[]` | MCP servers from `brain/mcp/`. `['*']` = all. The `memory` server is auto-injected. See [mcp.md](./mcp.md). |
| `commands` | No | string[] — `[]` | Slash-commands from `brain/commands/`. `['*']` = all. |
| `subagents` | No | string[] — `[]` | Agents this agent may delegate to via `spawn_subagent`. Omit = no delegation. **Not** wildcarded by convention — list them explicitly so the menu stays small. |
| `souls` | No | string[] — `[]` | Voice/disposition files from `brain/souls/`. **Omit/empty = include ALL souls; name a subset to narrow.** |
| `personas` | No | string[] — `[]` | Role framing from `brain/personas/`. Same empty=all rule. |
| `standards` | No | string[] — `[]` | Cross-cutting rules from `brain/standards/`. Empty = all. |
| `operations` | No | string[] — `[]` | Playbooks from `brain/operations/`. Empty = all. |
| `container` | No | object | Run this agent's `bash` in a specific image — see below. Omit to run in the warm agent runtime. |
| `timeAware` | No | bool — `true` | Inject the current date/time into the prompt each turn. |
| `timezone` | No | string — system tz | IANA tz (e.g. `Europe/London`); defaults to the system tz. |

> **Gotcha — `souls`/`personas`/`standards`/`operations` default to "all".** Omitting the
> field pulls in *every* file in that directory. Name a subset (e.g. `souls: [base]`) to
> include only those.

### `container:` (per-agent image)

```yaml
container:
  image: ghcr.io/inline-studio/dev-node:latest
  workdir: /workspace        # default
  bind: ["/host/path:/in/container:ro"]
  env: { FOO: bar }
  network: some-network      # optional
```

This controls **where the agent's `bash` runs** — and it's a real tradeoff:

- **With `container.image`:** each `bash` command runs in a fresh `docker run --rm`
  container of that image (`DockerRuntime`). Great for **isolated, stateless** steps (a
  build, a test) where state lives in the workspace bind. But it **boots a container per
  command**, and it **breaks stateful CLIs** — anything that keeps a process alive
  between commands (e.g. `agent-browser`'s `open` → `snapshot`) dies when the per-command
  container exits.
- **Without `container.image`:** the agent's `bash` runs via `HostRuntime` **inside its
  agent-turn container** — persistent across commands in the turn, no per-command boot.
  This is what the user-facing orchestrator wants (warm, and stateful tools work). The
  daedalus image carries Node + Chromium libs + common CLI tooling for exactly this.

Rule of thumb: **orchestrator / browser / interactive work → omit `container.image`**
(runs warm). **Per-language build/test leaves → set `container.image`** to the right
toolchain image (`dev-node`, `dev-python`, `dev-php-8.3`, …).

### `vision:` (image input)

Inbound images (e.g. a photo sent over Telegram) reach the agent as message content.
Whether they're sent to the model depends on `vision`:

```yaml
vision: false              # default — images are NOT sent to the model
vision: true               # the agent's own `model` is multimodal; send images to it
vision: "spark/qwen2-vl"   # route image-bearing turns to this vision model
```

- **`false` / omitted** — images are stripped before the model call. Use this when the
  model can't see (so it never errors on an image), which is the safe default.
- **`true`** — the agent's `model` accepts images, so the most recent one is passed
  straight through to it. (Older images are dropped so the same picture isn't re-sent and
  re-charged every turn.)
- **`"provider/model"`** — for setups where the main model is text-only but a separate
  vision model exists. Daedalus uses that model as a **describe-the-image step**: when an
  image arrives it makes a *minimal* side-call to the vision model — **just the image plus
  the user's message, with no conversation history and no tools** — gets a description
  back, splices it into the turn as text (`[Image description: …]`), and then your **main
  `model`** handles the turn normally with full context and tools.

  Why this shape: the vision model only ever sees a tiny payload, so it fits even a
  small-context VL model and never triggers compaction; your main model does the reasoning,
  voice, and any tool use, and never needs to be multimodal. It also generalises to "here's
  a photo, now *do something* with it." The cost is one extra (small) model call per image
  turn. If the vision model is unreachable, daedalus drops the image, tells the user, and
  the main model still replies — the turn never crashes.

## How the system prompt is composed

For each turn, daedalus assembles the prompt in this deterministic order:

```
Standards → Operations → Soul → Persona → Skills → <agent body> → (current date/time)
```

Each section pulls the files the agent selected (or all, per the empty=all rule). The
agent's own markdown body comes last before the time stamp, so it has the final word on
voice and task framing.

## Customising agents

- **Swap the model/provider:** change `provider` + `model`. Keys are resolved centrally
  (see [install.md](./install.md)) — you don't put real keys in the brain.
- **Give it capabilities:** add to `tools`, `skills`, `mcpServers`.
- **Shape its voice:** author a soul/persona and reference it (or rely on empty=all).
- **Build a team:** create subagents and list them under the orchestrator's `subagents:`.
- **Pick a runtime:** set `container.image` for toolchain leaves; omit it for warm,
  interactive agents.
- **Hot reload:** the brain is read fresh on every turn, so editing an agent's markdown
  takes effect on the next message — no restart, no rebuild. (Pulling a new
  `container.image` does require the image to be present on the host.)
