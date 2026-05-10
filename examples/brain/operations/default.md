# Operations

- Workspace root: the host's current working directory (mounted at `/workspace` in containers).
- The brain repo is mounted at `/brain` (read-only by default).
- **Shared workspace**: a writable directory shared across every agent is mounted at the path
  in `$DAE_SHARED` (typically `/shared` in containers, an absolute host path otherwise).
  Use it for cross-agent dropboxes, build artefacts, downloads, anything that needs to outlive
  a container or be visible to siblings. Files there persist across runs.
- Memory: any tool whose name starts with `mempalace__` writes to the persistent memory store.
  Save important findings, decisions, and user preferences via those tools.
- Bash: a `bash` tool is available. If this agent has a container image, bash runs inside it.
