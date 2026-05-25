# MCP servers

Agents reach external tools through [MCP](https://modelcontextprotocol.io) servers
declared in the brain. Daedalus connects the ones an agent lists in its `mcpServers:`
field (`['*']` = all), exposing each server's tools to the model.

## One file per server, auto-merged

Point `mcp.configPath` (in `daedalus.config.yaml`) at a **directory** — `brain/mcp/` by
convention — and daedalus reads **every `*.json` file** in it and merges them. Two
conventions:

1. **One server per file, keyed by filename.** If a file defines a single server under
   the key `default`, the server is named after the file. So:

   ```
   brain/mcp/github.json     →  server "github"
   brain/mcp/linear.json     →  server "linear"
   ```
   ```json
   // brain/mcp/github.json
   { "mcpServers": { "default": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }
   ```

   This is the recommended layout: add a capability by dropping in a file; remove it by
   deleting the file. No central registry to edit.

2. **Multiple named servers in one file.** If a file's keys aren't `default`, they're
   merged by name as-is. (A duplicate server name across files is an error — names must
   be unique once merged.)

Either `mcpServers` or `servers` works as the top-level key. A single file (instead of a
directory) is also accepted and read directly.

## Server definition

```json
{
  "mcpServers": {
    "default": {
      "command": "npx",                 // stdio servers: the binary to spawn
      "args": ["-y", "some-mcp-server"],
      "env": { "API_TOKEN": "${SOME_TOKEN}" },

      "url": "http://service:1234/mcp", // http/sse servers: the endpoint instead of command
      "transport": "http",              // "stdio" | "http" | "sse"
      "headers": { "Authorization": "Bearer ${SOME_TOKEN}" },
      "cwd": "/optional/working/dir"
    }
  }
}
```

- **stdio** servers: set `command` (+ `args`, `env`, `cwd`); daedalus spawns the process.
- **http / sse** servers: set `url` (+ `transport`, `headers`).
- **`${VAR}` expansion:** `env` and `headers` values expand from the process environment,
  so secrets stay out of the JSON. For agent containers, the referenced vars are forwarded
  in (see the dispatcher's `forwardEnv`).

## The auto-injected `memory` server

When `graphiti.enabled` is true and you haven't defined a `memory` server yourself, daedalus
injects one automatically — the Graphiti HTTP MCP at `graphiti.url`
(`http://graphiti:8000/mcp/`). **Every agent gets `memory`** regardless of its `mcpServers:`
list, so memory is a default capability. Define your own `memory` server to override. See
[install.md](./install.md) and [docker-mode.md](./docker-mode.md) for the memory stack.

## A note on networking

MCP HTTP/SSE traffic deliberately **bypasses the OneCLI MITM proxy** (it uses a direct
dispatcher). MCP servers are local and/or authenticate with their own headers — they
don't need OneCLI's per-request credential injection, and routing streaming transports
through the proxy corrupts them. (Same reasoning applies to the speech-to-text and
internal worker calls.)
