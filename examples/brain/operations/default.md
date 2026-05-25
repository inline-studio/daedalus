# Operations

- Workspace root: the host's current working directory (mounted at `/workspace` in containers).
- The brain repo is mounted at `/brain` (read-only by default).
- **Shared workspace**: a writable directory shared across every agent is mounted at the path
  in `$DAE_SHARED` (typically `/shared` in containers, an absolute host path otherwise).
  Use it for cross-agent dropboxes, build artefacts, downloads, anything that needs to outlive
  a container or be visible to siblings. Files there persist across runs.
- Memory: the persistent memory store is a Graphiti temporal knowledge graph, exposed as MCP
  tools whose names start with `memory__`. Save important findings, decisions, and user
  preferences with the `memory__` add/store tools, and recall them with the `memory__` search
  tools.
- Bash: a `bash` tool is available. If this agent has a container image, bash runs inside it.
