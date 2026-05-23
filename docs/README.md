# Daedalus documentation

Daedalus is an SDK-agnostic agent runner: you define a team of agents declaratively (the
*brain*), and daedalus runs them in containers, reachable over chat channels.

Start here:

- **[install.md](./install.md)** — `dae install`, the docker stack, LLM providers
  (OpenAI/Anthropic), Brave search, memory, OneCLI credential injection, and why the
  deployment is all-container.
- **[agents.md](./agents.md)** — the brain layout, why the orchestrator/subagent shape,
  the full agent-frontmatter reference, prompt composition, and how to customise agents.
- **[skills.md](./skills.md)** — building a skill: `SKILL.md`, the `bootstrap.sh` install
  script (and the no-root rule), the daedalus image, and the `agent-browser` example.
- **[channels.md](./channels.md)** — why Telegram, inbound + outbound attachments
  (`attach_to_reply`), and the CLI/Web/WhatsApp surfaces.
- **[mcp.md](./mcp.md)** — adding MCP servers (one file per server, auto-merged) and the
  auto-injected memory server.
- **[docker-mode.md](./docker-mode.md)** — the dispatch architecture: the supervisor, the
  warm worker, per-message agent containers, and the injected runtime.

Quick mental model:

```
You ──chat──▶ channel ──▶ supervisor ──▶ warm worker (top-level agent)
                                              │
                                              ├─ tools / skills / MCP / memory
                                              └─ spawn_subagent ──▶ per-agent containers
LLM + web calls ──▶ OneCLI proxy (injects real keys) ──▶ provider
```
