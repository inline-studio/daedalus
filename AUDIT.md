# Daedalus Codebase Audit

**Date:** 2026-06-11
**Scope:** Read-only audit of `src/` (TypeScript; ~17.5k LOC). No changes made.
**Stack:** Node ≥24 (ESM, `node:sqlite`), `@anthropic-ai/sdk` / `openai`, MCP SDK, Docker-per-agent runtime, custom HTTP/SSE web channel, Telegram/WhatsApp channels.

> **Important deployment-context caveat.** Daedalus is documented as a single-operator system with a *trusted* brain repo (personas/skills/commands authored by the operator) and an LLM-driven agent that is itself granted real shell + container + tool access. Several of the security findings below are only reachable by (a) a remote party who can message a channel, or (b) the agent/LLM itself being steered by injected content. Where exploitability hinges on that trust model, the finding says so. They are still reported because the agent is *designed* to act on untrusted input (web pages, inbound messages, attachments), which is exactly the indirect-injection surface.

---

## Summary

### Counts by category & severity

| Category | Critical | High | Medium | Low | Total |
|---|---|---|---|---|---|
| Security (SEC) | 2 | 6 | 7 | 5 | 20 |
| Bugs & correctness (BUG) | 0 | 0 | 6 | 12 | 18 |
| Dead code (DEAD) | 0 | 0 | 0 | 9 | 9 |
| Improvements (IMP) | 0 | 0 | 1 | 9 | 10 |
| **Total** | **2** | **6** | **14** | **35** | **57** |

### Top 5 highest-priority items

1. **SEC-02 (Critical)** — Every per-agent container mounts the host Docker socket read-write (`container.ts:161`). Any agent that can run `bash` has root-equivalent control of the host. Collapses all container isolation.
2. **SEC-01 (Critical)** — No sender authorization on the Telegram channel (`telegram.ts:121`, no allowlist in config). Anyone who finds the bot drives an agent with shell/container/tool access.
3. **SEC-06 (High)** — `schedule_message`'s `agent` argument is unvalidated (`schedule.ts:60`); a low-privilege subagent can schedule a turn that later runs as *any* agent with an attacker-chosen prompt — privilege escalation + deferred prompt injection.
4. **SEC-04 / SEC-05 (High)** — No SSRF protection in either `web/fetch.ts` (`fetch.ts:22`) or the kernel's attachment fetch (`ingest.ts:209`): private/link-local/cloud-metadata hosts are reachable, redirects are followed blindly, and the attachment path has no size cap or timeout.
5. **SEC-08 (High)** — Secret-bearing `.env.local` / compose `.env` files (session secret, password hash, bot token, OneCLI key, encryption key) are written with no `mode`, landing world-readable (`setup/env-file.ts:40`).

---

## Findings table

| ID | Category | Severity | Location | Description |
|---|---|---|---|---|
| SEC-01 | Security | Critical | `channels/telegram.ts:121` | ✅ **DONE** — No sender allowlist — any Telegram user can drive the agent |
| SEC-02 | Security | Critical | `dispatch/container.ts:161` | 🟡 **PARTIAL** — Host docker.sock mounted rw into every agent container (interim mitigation applied; broker follow-up deferred) |
| SEC-03 | Security | High | `dispatch/container.ts:151-207`, `runtime/docker.ts:27-54` | ✅ **DONE** — No container hardening (cap-drop, no-new-privileges, pids/memory/cpu limits) |
| SEC-04 | Security | High | `web/fetch.ts:22-34` | ✅ **DONE** — SSRF: no private-IP/metadata/scheme/redirect validation in web_fetch |
| SEC-05 | Security | High | `kernel/ingest.ts:209-218` | ✅ **DONE** — Attachment fetch: SSRF + no size cap + no timeout |
| SEC-06 | Security | High | `tools/schedule.ts:60` | ✅ **DONE** — `schedule_message` target agent unvalidated → cross-agent privilege escalation |
| SEC-07 | Security | High | `mcp/client.ts:71` | ✅ **DONE** — stdio MCP servers inherit the supervisor's entire `process.env` (all secrets) |
| SEC-08 | Security | High | `setup/env-file.ts:40-41` | ✅ **DONE** — Secret files written world-readable (no chmod 600) |
| SEC-09 | Security | Medium | `dispatch/container.ts:185-197,284-293` | ✅ **DONE** — Secrets passed as `-e KEY=VALUE` argv, visible via `ps`/`/proc/<pid>/cmdline` |
| SEC-10 | Security | Medium | `brain/skills.ts:22`, `brain/agents.ts:16`, `brain/commands.ts:40` | gray-matter `---js` front-matter `eval()`s arbitrary code at file-load |
| SEC-11 | Security | Medium | `brain/skill-bootstrap.ts:116-125` | `bootstrap.sh` runs unsandboxed with full `process.env` |
| SEC-12 | Security | Medium | `channels/format/telegram-html.ts:135-137` | Link href not attribute-escaped for `"`, no scheme allowlist → HTML attribute injection |
| SEC-13 | Security | Medium | `cli/update.ts:66-69` | `dae update` runs `npm install -g <tarball>` with no checksum/signature check |
| SEC-14 | Security | Medium | `setup/env-file.ts:44-47` | Newline in a secret value injects a spurious env var on round-trip |
| SEC-15 | Security | Medium | `mcp/loader.ts:13`, `mcp/client.ts:79-88` | MCP `url` only syntactically validated; SSRF-capable and bypasses the OneCLI proxy |
| SEC-16 | Security | Low | `brain/skills.ts:18`, `brain/agents.ts:13`, `brain/commands.ts:37` | Latent path traversal in name→path resolution (not currently reachable) |
| SEC-17 | Security | Low | `web/search/duckduckgo.ts:37-39` | DDG `uddg` redirect target emitted without scheme/host validation |
| SEC-18 | Security | Low | `channels/telegram.ts:23,185` | Bot token embedded in URL strings (latent log/stack-trace leak) |
| SEC-19 | Security | Low | `web/fetch.ts:80` → `tools/web.ts` | Fetched web content returned to model with no untrusted-content framing (indirect injection) |
| SEC-20 | Security | Low | `brain/skill-bootstrap.ts:100` | Bootstrap change-detection hash truncated to 64 bits |
| BUG-01 | Bug | Medium | `dispatch/container.ts:246-263` | Forgeable DispatchResult: any JSON line on agent stdout can spoof the turn result |
| BUG-02 | Bug | Medium | `scheduler/poller.ts:143` | Recurring fires anchored on wall-clock `now`, not `due_at` → schedule drift |
| BUG-03 | Bug | Medium | `scheduler/parse-when.ts:50,67`, `scheduler/cron.ts:76` | No timezone passed to croner → schedules fire in host TZ (usually UTC) |
| BUG-04 | Bug | Medium | `scheduler/poller.ts:68`, `sessions/schedule-store.ts:249-256` | Failed fire returns to `pending` with same `due_at` → infinite retry, no backoff |
| BUG-05 | Bug | Medium | `providers/anthropic.ts:20`, `providers/openai.ts:24` | Providers advertise `streaming: true` but never stream |
| BUG-06 | Bug | Medium | `channels/telegram.ts:42-44,101` | `stop()` doesn't abort the in-flight long-poll → up to 30s hang + post-stop dispatch |
| BUG-07 | Bug | Low | `providers/anthropic.ts:65-67` | Usage parsing ignores cache token fields → understated input usage |
| BUG-08 | Bug | Low | `sessions/schedule-store.ts:213` | `claimDue` returns rows with stale `status: "pending"` after flipping to `firing` |
| BUG-09 | Bug | Low | `scheduler/parse-when.ts:53-61` | Valid cron with no future fire reported as a generic parse error |
| BUG-10 | Bug | Low | `web/markdown.ts:69-82` | `byteLength` reported pre-truncation when content was truncated |
| BUG-11 | Bug | Low | `web/fetch.ts:52-61` | Byte-cap truncation can split a multibyte UTF-8 sequence |
| BUG-12 | Bug | Low | `attachments/store.ts:36-40` | `putBuffer` check-then-act, non-atomic write (partial-read race) |
| BUG-13 | Bug | Low | `channels/telegram.ts:124,158` | Caption + failed media download silently drops the media |
| BUG-14 | Bug | Low | `channels/whatsapp.ts:39-54` | Outbound send ignores `res.ok` → failed WhatsApp sends vanish silently |
| BUG-15 | Bug | Low | `kernel/agent-turn.ts:99` | `runSkillBootstraps` result discarded → bootstrap failures invisible to the turn |
| BUG-16 | Bug | Low | `config/load.ts:18-22` | Unresolved `${VAR}` becomes `""` → missing secrets pass schema validation |
| BUG-17 | Bug | Low | `dispatch/container.ts:100-121` | Container only force-removed on timeout; other failure paths can leak containers |
| BUG-18 | Bug | Low | `dispatch/persistent.ts:80` | Worker HTTP response cast to `DispatchResult` with no shape validation |
| DEAD-01 | Dead | Low | `config/schema.ts:106` | `mcp.inline` config field parsed but never consumed |
| DEAD-02 | Dead | Low | `runtime/base.ts:12-14` | ✅ **DONE** (via SEC-03) — `ExecOptions.memory`/`cpus` never set by any caller (limit plumbing dead) |
| DEAD-03 | Dead | Low | `channels/base.ts:51` | `OutgoingMessage.toExternalUserId` declared but never read |
| DEAD-04 | Dead | Low | `brain/skills.ts:10,24` | `LoadedSkill.readOnly` set but never read |
| DEAD-05 | Dead | Low | `brain/agents.ts:9,17`, `brain/commands.ts:33,42` | `sourcePath` on LoadedAgent/LoadedCommand never consumed |
| DEAD-06 | Dead | Low | `memory/base.ts:16-25`, `memory/brain-sync.ts:22` | brain-sync `recent()`/`append()` path unreachable with existing backends |
| DEAD-07 | Dead | Low | `config/schema.ts:149-171` | `mempalace` config block deprecated, no consumer (kept for back-compat) |
| DEAD-08 | Dead | Low | `attachments/whisper-provision.ts:11` | `whisperProvisionUrl` exported but only used internally |
| DEAD-09 | Dead | Low | `brain/skill-bootstrap.ts:44-52` | `skillBinRoot`/`sharedBinDir`/`perSkillDir` exported, no external consumer |
| IMP-01 | Improvement | Medium | `web/fetch.ts:22` vs `kernel/ingest.ts:209` | ✅ **DONE** (via SEC-05) — Two divergent `fetchUrl` impls; the weaker one has no caps/SSRF guard |
| IMP-02 | Improvement | Low | `dispatch/in-process.ts:12`, `container.ts:211`, `persistent.ts:30` | Dispatch payload construction hand-rolled 3× |
| IMP-03 | Improvement | Low | `config/load.ts:36`, `install.ts:892,1043` | Config/compose path-candidate lists duplicated 3× and already drifting |
| IMP-04 | Improvement | Low | `setup/env-file.ts:41`, `setup/yaml-edit.ts:13`, `setup/mcp-edit.ts` | Non-atomic config/secret writes (no temp-file + rename) |
| IMP-05 | Improvement | Low | multiple (`dispatch/persistent.ts:80`, `channels/telegram.ts:174`, providers) | `as`-casts at trust boundaries instead of validated parsing |
| IMP-06 | Improvement | Low | `brain/agents.ts:20`, `commands.ts:48`, `skills.ts:64`, `composer.ts:9` | `.md`-listing logic reimplemented 4× |
| IMP-07 | Improvement | Low | `channels/telegram.ts:82-98`, `whatsapp.ts:39` | Partial-delivery (text ok, attachment failed) never surfaced to the user |
| IMP-08 | Improvement | Low | `providers/openai.ts:33`, `anthropic.ts:29`, `index.ts:34` | Placeholder API-key fallbacks mask misconfiguration until a downstream 401 |
| IMP-09 | Improvement | Low | `mcp/client.ts:97-111` | MCP tool args forwarded without validating against the tool's `inputSchema` |
| IMP-10 | Improvement | Low | `scheduler/cron.ts:76-108` vs `poller.ts:107-156` | Static-cron path silently discards the agent's reply; poller path delivers it |

---

## Detail — Security

### SEC-01 (Critical) — No sender authorization on Telegram
**Status: ✅ DONE** — Added a fail-closed `allowedChatIds` allowlist to the telegram config schema (`config/schema.ts`), wired it through `registry.ts`, and enforced it in `TelegramChannel.handleMessage` (drops non-allowlisted chat ids before any attachment download; unconfigured allowlist rejects everyone, with a startup warning + per-rejection chat-id log so the operator can discover their id). Documented in `examples/daedalus.config.yaml`. Scoped to Telegram only — WhatsApp inbound is an unimplemented stub. Type-check clean. Commit `133b563`. _Operator action: set `channels.telegram.allowedChatIds` in the live config (Scott's id: `8724271796`)._

**What:** `TelegramChannel.handleMessage` (`channels/telegram.ts:121`) publishes every inbound message to the agent pipeline; `serve.ts:61` dispatches it straight to the agent. There is no allowlist of permitted chat/user IDs anywhere — confirmed by grep across `config/schema.ts` and `channels/*` (no `allow*`/`whitelist` field exists). WhatsApp has the same shape.
**Why it matters:** The agent has `bash`, container spawn, file, web, and MCP tools. Anyone who discovers the bot handle can issue commands, exfiltrate data, or run up model cost. For a channel exposed to the public Telegram network this is effectively an unauthenticated RCE-capable surface.
**Fix (described):** Add `allowedChatIds: string[]` (and/or `allowedUserIds`) to the telegram/whatsapp config schema; in `handleMessage`, drop messages whose `m.chat.id` isn't in the list (log at info). Fail closed when the list is empty *and* the channel is reachable beyond localhost.

### SEC-02 (Critical) — Host Docker socket mounted into every agent container
**Status: 🟡 PARTIAL (interim mitigation applied; broker follow-up deferred)** — Commit `2a7ede0`. The `docker.sock` mount is now gated on `manifest.subagents.length > 0` (`dispatch/container.ts` — `dispatch()` derives `mountDockerSock`, threaded through `buildContainerArgs`; fail-closed if the manifest can't load). Leaf agents (e.g. `cypher-php8.5`) — the ones running bash over untrusted web content — no longer receive the host socket; only spawning agents (`artemis`, `cypher`) do, so the cascade still works. Regression coverage added in `scripts/smoke-dispatcher.mjs` (block 11, both branches); smoke + typecheck clean.

**⚠️ This does NOT fully close the finding.** A spawning agent still has the raw socket = host root. See the follow-up below.

#### Follow-up (deferred) — SEC-02-BROKER: remove docker from agent containers entirely
A stock `docker-socket-proxy` is **not** sufficient: it filters by API endpoint, not request body, so `POST /containers/create` with `HostConfig.Binds: ["/:/host"]` still escapes to the host fs. The real fix is a **spawn broker**:
- Agent containers get **no** docker access (no socket, no `DOCKER_HOST`).
- `spawn_subagent` (in-container) posts `DispatchArgs` to a privileged broker over the docker network — same shape as the existing `PersistentContainerDispatcher` → worker pattern, inverted. New `BrokerDispatcher` (in-container client) selected in `buildDispatcher` when a broker URL is present.
- The broker is the only component with docker; it runs `ContainerAgentDispatcher`, building `docker run` with the *fixed, safe* mount set and validating the requested agent name against the brain. Agents can't choose mounts/images/flags.
- Spawned subagents receive the broker URL + token, so cascading (`artemis → cypher → cypher-php8.5`) is preserved at arbitrary depth.
- Pairs naturally with **SEC-03** (container hardening: `--cap-drop=ALL`, `--security-opt no-new-privileges`, `--pids-limit`, memory/cpu) applied centrally in the broker's arg builder.
- Scope: new authenticated HTTP endpoint (worker/supervisor), in-container `BrokerDispatcher`, token plumbing, compose changes, deploy-side testing on the live stack. Larger than a single-file edit — schedule as its own change.

**What:** `buildContainerArgs` unconditionally adds `-v /var/run/docker.sock:/var/run/docker.sock` (read-write) to every per-agent container (`dispatch/container.ts:161`). The comment frames it as "so nested subagent spawns work".
**Why it matters:** Access to the Docker daemon socket is root-equivalent on the host (mount `/` into a new container, run `--privileged`, etc.). An LLM-controlled process with `bash` inside the container can therefore escape to host root, defeating every other isolation measure. This is the single biggest exposure in the codebase.
**Fix (described):** Don't mount the raw socket. Route subagent spawns through a restricted socket proxy (e.g. `tecnativa/docker-socket-proxy` limited to `container create/start`), or only mount it for agents whose manifest actually declares subagents, and even then read-only behind a proxy. Make it explicit opt-in, off by default.

### SEC-03 (High) — No container hardening or resource limits
**Status: ✅ DONE** — Commit `7f2fdde`. Both container launch paths (`buildContainerArgs` for the per-turn/subagent container, and `DockerRuntime.exec` for host-mode per-command containers) now add `--cap-drop=ALL`, `--security-opt=no-new-privileges`, `--pids-limit`, `--memory`, and `--cpus`. **Resource limits are per-agent**: new `container.memory`/`cpus`/`pidsLimit` manifest fields override the **conservative global defaults** (`runtime.limits` → **1 CPU / 1 GB / 512 PIDs**); an agent with no `container:` block still gets the defaults. Resolved by a shared `resolveContainerLimits()`. cap-drop+no-new-privileges are always on (safe — containers are non-root uid 1000). Wires up the dead `ExecOptions.memory/cpus` (**DEAD-02**). Documented prominently in `README.md`, `docs/agents.md`, and `examples/daedalus.config.yaml`. Verified by `smoke-dispatcher` (flags + default vs per-agent override) + full CI-safe suite (56/56). _Pairs with SEC-02-BROKER, which will reuse this same `buildContainerArgs`. Validate on colima before live._

**What:** Neither the dispatcher's `docker run` (`container.ts:151-207`) nor `DockerRuntime.exec` (`runtime/docker.ts:27-54`) set `--cap-drop`, `--security-opt no-new-privileges`, `--read-only`, `--pids-limit`, `--memory`, or `--cpus`. The `ExecOptions.memory`/`cpus` fields exist but are never populated (see DEAD-02), so the limit branches are dead.
**Why it matters:** Default-capability containers have a large kernel attack surface; with no PID/memory limit a single agent turn can fork-bomb or OOM the whole host stack.
**Fix (described):** Add `--cap-drop=ALL` (re-add only what's needed), `--security-opt=no-new-privileges`, `--pids-limit`, and default `--memory`/`--cpus`; wire `config.runtime` limits through `buildRuntime` into `DockerRuntime`.

### SEC-04 (High) — SSRF in `web_fetch`
**Status: ✅ DONE** — Commit `19dd23b`. New reusable guard `src/web/ssrf.ts` (`assertPublicHostAllowed` / `isBlockedIp`): enforces http/https scheme, blocks loopback/private (10·8, 172.16·12, 192.168·16)/link-local+metadata (169.254·16)/CGNAT/IPv6 ULA+link-local/v4-mapped/`localhost`, resolves hostnames and checks every address, with an exact-host `web.fetch.allowHosts` allowlist (default empty). `fetchUrl` now runs the guard and follows redirects **manually** (≤5 hops, re-checked per hop). **OneCLI untouched** — the guard is a pre-flight go/no-go gate; allowed requests tunnel through the proxy + dummy→real key swap exactly as before. **Graphiti/mempalace unaffected** — they're reached via the MCP client (`mcp/client.ts`, separate dispatcher), never `fetchUrl`. Verified by `scripts/smoke-ssrf.mjs` (28 cases) + a live trace (public fetch 200; metadata blocked). _Residual: DNS-rebinding when proxied (proxy does the final connect) — complement with OneCLI egress policy._

**What:** `fetchUrl` (`web/fetch.ts:22-34`) passes the URL to `fetch()` with `redirect: "follow"` and no validation of host/IP, no redirect cap, and scheme checking only in the tool wrapper (`tools/web.ts:30`), not the shared function. Nothing blocks `localhost`, RFC-1918 ranges, link-local `169.254.169.254` (cloud metadata), `0.0.0.0`, or IPv6 internals, and a public URL can 30x-redirect to an internal host after the front-door check.
**Why it matters:** `web_fetch` is model/user-driven and the agent is designed to fetch attacker-influenced URLs (prompt-injected pages, user requests). This is a direct path to read cloud metadata / internal services.
**Fix (described):** Resolve the host and reject loopback/private/link-local/metadata IPs before connecting; set `redirect: "manual"` and follow hops in code with a bounded count, re-validating each `Location`; restrict scheme to http/https inside `fetchUrl` itself.

### SEC-05 (High) — Unhardened attachment fetch in the kernel
**Status: ✅ DONE** — Commit `d1eeb34`. `ingest.ts`'s bare local `fetchUrl` is removed; attachment URLs now go through a new **`fetchBytes`** in `web/fetch.ts` — SSRF-guarded (shared `guardedFetch` core, same blocklist + manual bounded redirects as SEC-04, reusing `web.fetch.allowHosts`), **size-capped** (new `attachments.maxFetchBytes`, default 25 MB, configurable), and **time-bounded** (`attachments.fetchTimeoutMs`, default 30s). A blocked/oversized/slow URL just skips the attachment (null) as before. Verified: `smoke-ssrf` (shared guard) + a trace (internal/metadata blocked, public body capped to exactly 100 bytes) + the attachment/audio ingest smokes. Documented in `examples/daedalus.config.yaml`.

**What:** A second, private `fetchUrl` in `kernel/ingest.ts:209-218` does a bare `fetch(url)` then `arrayBuffer()` on an inbound `attachment.url`, with no host validation, no size cap, and no timeout (called at `ingest.ts:90`).
**Why it matters:** An inbound message can supply an `attachment.url` pointing at an internal service (SSRF) or a huge/slow body to exhaust memory or hang the turn. Worse than SEC-04 because it runs in the supervisor before any agent sandboxing.
**Fix (described):** Route attachment fetches through one hardened fetch utility (see IMP-01) with the SSRF blocklist, a byte cap, and an `AbortController` timeout.

### SEC-06 (High) — Cross-agent scheduling = privilege escalation
**Status: ✅ DONE** — Commit `c0b80df`. `schedule_message` now authorizes the target: an agent may schedule only **itself** or an agent it could **spawn** (its `manifest.subagents`, `'*'` = all). This mirrors the `spawn_subagent` trust edge exactly, so scheduling grants no reach the caller doesn't already have synchronously — and enforces the hierarchy rule `artemis → cypher → cypher-php8.5` (an agent can schedule down/self, never up or sideways). Policy extracted as a pure exported `scheduleTargetAllowed()` and verified by `scripts/smoke-schedule-authz.mjs` against the full matrix; fails closed if the caller's manifest can't load. **Caveat (documented):** a mid-tier agent given `subagents: ['*']` could schedule *up* (because `'*'` = all-minus-self) — keep `'*'` to the top orchestrator only; scheduling faithfully mirrors whatever spawn rights are granted. _Optional follow-up: fire-time re-validation in the poller as defense-in-depth against any pre-existing escalated rows (enqueue-time is the primary fix)._

**What:** `schedule_message` takes `agent = input.agent ?? ctx.agentName` verbatim with no allowlist (`tools/schedule.ts:60`) and stores it as the row's `agent_name`. At fire time the poller dispatches that agent (`poller.ts:125`) with the stored prompt. The `createdByAgent` scoping only governs `cancel`/`list`, not who runs.
**Why it matters:** A low-privilege subagent can enqueue a deferred turn that executes under a *different, higher-privilege* agent's identity/image/brain mount, with a prompt it fully controls — a privilege-escalation + delayed-prompt-injection primitive.
**Fix (described):** Validate `input.agent` against an explicit allowlist of agents the caller may target (e.g. only the orchestrator may target other agents; subagents may only self-schedule).

### SEC-07 (High) — stdio MCP servers inherit all host secrets
**Status: ✅ DONE** — Commit `72973d3`. Replaced the `{ ...process.env, ...def.env }` spread with an allowlisted `baseMcpEnv()` (PATH/HOME/locale/TZ/TMPDIR + OneCLI proxy & MITM-CA vars) layered with the server's own `def.env`. Secrets (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `WEB_*`, `SECRET_ENCRYPTION_KEY`, `MEMPALACE_TOKEN`, `ONECLI_API_KEY`, …) are no longer auto-shared. Verified by `scripts/smoke-mcp-env.mjs`. **Current live impact: none** — all configured MCP servers are http/sse (no stdio child is spawned); this is forward-hardening. The `mcp.passEnv` escape-hatch was intentionally **not** added (would be dead config with no stdio servers; trivial to add later). **Behaviour note:** any future stdio server that relied on an *inherited* secret must declare it explicitly (`env: { FOO: "${FOO}" }`).

**What:** Every stdio MCP child is spawned with `env: { ...process.env, ...def.env }` (`mcp/client.ts:71`); the JSON config is also `${VAR}`-expanded at load (`mcp/loader.ts:64`).
**Why it matters:** Each MCP server process receives the supervisor's entire environment — every API key, bearer token, and the encryption key. A single malicious/compromised MCP entry exfiltrates all credentials. Acceptable only if the MCP config file is fully operator-owned and never agent-writable; confirm that provenance.
**Fix (described):** Inject only an explicit allowlist (`PATH`, the specific `DAE_*` the server needs) plus `def.env` into stdio children, not all of `process.env`.

### SEC-08 (High) — Secret files written world-readable
**Status: ✅ DONE (scoped to the env files; config.yaml/mcp.json deliberately excluded)** — Commit `4538642`. `upsertEnvFile` now writes `0600` + `chmod`s an existing (possibly `0644`) file + creates the parent dir `0700`. This covers BOTH secret files (`.env.local` and the compose `.env`) in one place, since `install.ts` writes both via `upsertEnvFile`. Verified by trace (new file `0600`; pre-existing `0644` tightened; content preserved) and the secrets smoke test.

**Why `yaml-edit.ts` / `mcp-edit.ts` were NOT changed (deviation from the original fix text, on purpose):** the container image runs as **non-root uid 1000** (`Dockerfile:91`) and the config dir is bind-mounted **read-only** into the supervisor + agent containers (`docker-compose.yml:104,167`). `config.yaml` IS read in-container (`DAE_CONFIG=/etc/daedalus/config.yaml`), so `chmod 0600` (owned by the host user) would make it unreadable to uid 1000 and break the stack unless the host uid is exactly 1000. The env files, by contrast, are read host-side only — the containers load `.env.local` relative to CWD `/app` (not the `/etc/daedalus` mount) and get secrets via compose-passed env vars — so `0600` on them is safe. Hardening config.yaml/mcp.json would need ownership/uid alignment and is left as a separate, deliberate decision.

**Operator hygiene note (no code change):** the live `config.yaml` inlines the Telegram bot token in plaintext while `.env.local` already defines `TELEGRAM_BOT_TOKEN`. Switching that line to `token: ${TELEGRAM_BOT_TOKEN}` removes the only raw secret from config.yaml (needs the var present in the container env).

**What:** `upsertEnvFile` (`setup/env-file.ts:40-41`) and the YAML/MCP writers (`setup/yaml-edit.ts:13`, `setup/mcp-edit.ts:29,48,73`) call `fs.writeFile` with no `mode`. These hold `WEB_SESSION_SECRET`, `WEB_PASSWORD_HASH`, `TELEGRAM_BOT_TOKEN`, `ONECLI_API_KEY`, `SECRET_ENCRYPTION_KEY`, `GRAPHITI_REMOTE_TOKEN`. At default umask they land `0644`.
**Why it matters:** Any local user can read the session-signing secret (forge login cookies), the at-rest encryption key, and bot tokens.
**Fix (described):** Write with `{ mode: 0o600 }`, `fs.chmod` existing files after each write, and `0o700` the parent dir.

### SEC-09 (Medium) — Secrets in docker run argv
**Status: ✅ DONE** — Commit `<pending>`. `ONECLI_API_KEY` and the `forwardEnv` secrets (`MEMPALACE_TOKEN`) are now forwarded **by name** (`-e KEY`, no value) on the `docker run` argv; the dispatcher supplies their values via the `execa` call's `env`, so docker pulls them from its own environment. The values move off the world-readable `/proc/<pid>/cmdline` to the docker process's owner-only `/proc/<pid>/environ`. Non-secret `DAE_*` vars stay inline. `DockerRuntime.exec`'s `-e` only carries `DAE_SHARED` (non-secret), so it's out of scope. Verified by `smoke-dispatcher` (by-name form present; no secret values in argv).

**What:** Secrets are forwarded as `-e MEMPALACE_TOKEN=<value>` and `-e ONECLI_API_KEY=<value>` on the `docker run` command line (`container.ts:185-197`, env build `:284-293`).
**Why it matters:** Command-line args are world-readable via `/proc/<pid>/cmdline` and `ps`, leaking bearer tokens to any local process and to the docker daemon's audit surface.
**Fix (described):** Pass via `--env-file` or `-e KEY` (value inherited from the already-set dispatcher env) so the value never appears in argv.

### SEC-10 (Medium) — gray-matter JS front-matter `eval()`
**What:** `matter(text)` is called with default options in `brain/skills.ts:22`, `brain/agents.ts:16`, `brain/commands.ts:40`. gray-matter 4.0.3's `javascript` engine runs `---js` front-matter through `eval()` at parse time.
**Why it matters:** Any brain `.md` file opening with a `---js` block executes arbitrary Node in-process at load — a second code-execution surface beyond `bootstrap.sh`. Gated on the brain being trusted, but it's an unnecessary one.
**Fix (described):** Pass `matter(text, { language: "yaml", engines: { javascript: () => { throw … } } })` at every call site to disable the JS engine.

### SEC-11 (Medium) — `bootstrap.sh` runs unsandboxed with full env
**What:** Each skill's `bootstrap.sh` runs via `execa("/bin/sh", [scriptPath])` with `env: { ...process.env, … }` on the host (`brain/skill-bootstrap.ts:116-125`). The content-hash marker only prevents *re-runs*, not malicious content.
**Why it matters:** A skill script gets full host execution and read access to every secret in the environment. Same trust caveat as SEC-10.
**Fix (described):** Pass a minimal allowlisted env (PATH + the two `DAE_*` vars); document/enforce trusted-brain provenance.

### SEC-12 (Medium) — HTML attribute injection in Telegram formatter
**What:** Markdown link URLs are inserted into `href="..."` unescaped for `"`; `htmlEscape` only handles `& < >` (`channels/format/telegram-html.ts:135-137,267`). A URL containing `"` breaks out of the attribute; `javascript:`/`data:` schemes also pass through unvalidated.
**Why it matters:** Agent output that quotes attacker-influenced URLs (e.g. from a fetched page) can inject attributes/markup into outbound Telegram messages, or produce messages Telegram rejects.
**Fix (described):** Use an attribute-escaper that also encodes `"` → `&quot;` for the href, and allowlist `http`/`https`/`tg`/`mailto` (drop the link, keep label text, otherwise).

### SEC-13 (Medium) — Unverified self-update
**What:** `dae update` builds `https://github.com/.../daedalus-<tag>.tgz` from the GitHub API `tag_name` and runs `npm install -g <tarball>` (which executes install scripts) with no checksum/signature verification (`cli/update.ts:66-69`); `tag_name` is also used unsanitised in the URL.
**Why it matters:** The installed code is whatever that URL serves; a compromised/MITM'd artifact runs with no detection (HTTPS is the only control).
**Fix (described):** Publish + verify a SHA-256 (or sigstore provenance) before install; validate `tag_name` against a strict semver regex.

### SEC-14 (Medium) — Env-file value injection via newline
**What:** `quoteValue` (`setup/env-file.ts:44-47`) escapes `\` and `"` but not newlines; a value containing `\n` is written verbatim inside quotes, so re-parsing splits it into a spurious second `KEY=...` line.
**Why it matters:** A newline in one secret value can inject an arbitrary additional env var or truncate the intended one on the next round-trip.
**Fix (described):** Reject/strip control characters in `quoteValue`, or encode `\n`/`\r` as escapes and decode on read.

### SEC-15 (Medium) — MCP URL has no SSRF/scheme guard and bypasses the proxy
**What:** MCP `url` is validated only as a syntactic URL (`mcp/loader.ts:13`); `mcpDirectFetch` (`mcp/client.ts:79-88`) deliberately bypasses the OneCLI proxy. Any `http(s)` host — including `169.254.169.254` or internal services — is connected to with agent-influenced headers.
**Why it matters:** If MCP defs ever derive from less-trusted input, this is an SSRF vector made worse by the deliberate proxy bypass.
**Fix (described):** Restrict allowed schemes/hosts, or require explicit operator opt-in for non-loopback MCP URLs.

### SEC-16 (Low) — Latent path traversal in name→path resolution
**What:** `loadSkill`/`loadAgent`/`loadCommand` build paths via `path.join(brainPath, …, name)` with no containment check (`brain/skills.ts:18`, `agents.ts:13`, `commands.ts:37`). Today every `name` is a directory-listing result or an enum-constrained manifest entry, so it isn't reachable from untrusted input.
**Why it matters:** A future caller passing a user-influenced name (e.g. `../../etc/...`) would escape the brain dir.
**Fix (described):** After resolving, assert `path.resolve(file).startsWith(path.resolve(brainRoot) + path.sep)` and reject otherwise.

### SEC-17 (Low) — DDG redirect target not validated
**What:** The decoded `uddg` value is emitted as the result URL with only a `//host` → `https://host` rewrite, no scheme/host check (`web/search/duckduckgo.ts:37-39`).
**Why it matters:** A scraped result could carry a `javascript:`/`data:`/internal-host URL that later flows into `web_fetch` (chains with SEC-04).
**Fix (described):** Validate the unwrapped URL is http/https before emitting.

### SEC-18 (Low) — Bot token embedded in URLs
**What:** The Telegram token is interpolated into `getUpdates`/`getFile`/file-download URLs (`channels/telegram.ts:23,185`). Current logs avoid the URL, but the pattern is fragile.
**Why it matters:** Any future log of one of these URLs (or a fetch error embedding it) leaks the token.
**Fix (described):** Keep the token out of any logged object; scrub URLs before logging.

### SEC-19 (Low) — Fetched content returned without untrusted-content framing (informational)
**What:** Fetched HTML→markdown is returned verbatim into the model context with no provenance markers (`web/fetch.ts:80` → `tools/web.ts`).
**Why it matters:** Classic indirect prompt injection — page content becomes model instructions; chains with SEC-04.
**Fix (described):** Wrap tool output in clearly-delimited "untrusted external content" framing.

### SEC-20 (Low) — Bootstrap change-detection hash truncated to 64 bits
**What:** The "already ran" marker uses `sha256(...).slice(0,16)` (`brain/skill-bootstrap.ts:100`).
**Why it matters:** Not security-critical (change detection, not auth), but a 64-bit truncation needlessly weakens skip-detection.
**Fix (described):** Use the full digest (or ≥32 chars).

---

## Detail — Bugs & correctness

### BUG-01 (Medium) — Forgeable DispatchResult from agent stdout
**What:** `parseDispatchResult` scans stdout bottom-up for the first line starting with `{` that parses as JSON with a valid `status` (`dispatch/container.ts:246-263`). The agent's own tool output (e.g. a `bash` command that prints `{"status":"complete","finalText":"…"}`) is interleaved into the same stdout.
**Why it matters:** An agent — or any tool it runs — can emit a crafted JSON line that the dispatcher accepts as the authoritative turn result, overriding the real outcome and delivering attacker-chosen `finalText`/`attachments` to the user.
**Fix (described):** Frame the real result with a unique sentinel prefix (or write it to fd 3 / a file) and parse only sentinel-wrapped lines.

### BUG-02 (Medium) — Recurring schedule drift
**What:** `nextCronFire(row.recurringCron)` defaults `after` to `new Date()` (`scheduler/poller.ts:143`), computing the next occurrence from actual fire time (up to one 30s poll interval + processing late) rather than the stored `due_at`.
**Why it matters:** A `*/10 * * * *` slowly drifts off the :00/:10 boundaries; every fire accumulates poll latency.
**Fix (described):** Anchor on the scheduled time: `nextCronFire(cron, new Date(row.dueAt))`, guarding against a result still in the past.

### BUG-03 (Medium) — No timezone for cron
**What:** Every `new Cron(...)` omits the `timezone` option (`scheduler/parse-when.ts:50,67`, `scheduler/cron.ts:76`), so `"0 9 * * *"` means 9am in the host/container local time (UTC in docker mode).
**Why it matters:** "Every morning at 9" silently means 9am UTC with no way to specify a zone.
**Fix (described):** Thread a configured timezone (per-agent `timezone` already exists on the manifest, or a global config) into all croner call sites.

### BUG-04 (Medium) — Failing schedule retries forever
**What:** On any fire exception, `markFailed` flips the row back to `pending` with `due_at` unchanged (`poller.ts:68`, `schedule-store.ts:249-256`), so `claimDue` re-claims it every 30s indefinitely.
**Why it matters:** A poison row (missing agent image, always-erroring prompt) becomes an infinite hot loop dispatching real container runs every tick.
**Fix (described):** Add an attempts/backoff column and dead-letter after N failures (the store comment already flags this).

### BUG-05 (Medium) — `streaming: true` but no streaming
**What:** Both providers set `capabilities.streaming = true` (`providers/anthropic.ts:20`, `providers/openai.ts:24`) yet `complete()` makes a single blocking call; no streaming path exists.
**Why it matters:** Any consumer trusting the flag assumes incremental output the provider can't deliver — a false capability.
**Fix (described):** Set `streaming: false` until a real streaming path exists.

### BUG-06 (Medium) — Telegram `stop()` doesn't cancel the long-poll
**What:** `stop()` only sets `running = false` (`channels/telegram.ts:42`); the in-flight `getUpdates` (timeout 30s) keeps running and the poll loop isn't awaited or aborted (`:101`).
**Why it matters:** Shutdown can hang up to ~30s and a final update batch can be dispatched against torn-down dependencies.
**Fix (described):** Hold an `AbortController`, abort it in `stop()`, and await the poll-loop promise.

### BUG-07 (Low) — Anthropic usage drops cache tokens
**What:** Only `input_tokens`/`output_tokens` are read; `cache_creation_input_tokens`/`cache_read_input_tokens` are ignored (`providers/anthropic.ts:65-67`).
**Why it matters:** Usage/cost telemetry understates real input tokens on cached requests — relevant given the project's prompt-caching work.
**Fix (described):** Include the cache token fields in normalized usage.

### BUG-08 (Low) — `claimDue` returns stale status
**What:** `out.push(rowToScheduledMessage(row))` pushes the pre-UPDATE SELECT row whose `status` is still `"pending"` after the row was flipped to `"firing"` (`sessions/schedule-store.ts:213`).
**Why it matters:** Harmless today (the poller never reads it) but a latent trap for any future consumer.
**Fix (described):** Overwrite `status: "firing"` on the returned object after a successful update.

### BUG-09 (Low) — Misleading cron parse error
**What:** The `if (!next) throw …"no future fire"` is inside the try whose catch rewrites every error to "must be in N minutes/…" (`scheduler/parse-when.ts:53-61`).
**Why it matters:** A valid-but-never-firing cron is reported as unparseable.
**Fix (described):** Move the `!next` check outside the try/catch.

### BUG-10 (Low) — Wrong `byteLength` after truncation
**What:** `byteLength` is computed before `md.slice(0, maxBytes)` and returned as-is (`web/markdown.ts:69-82`).
**Why it matters:** Callers logging/deciding on `byteLength` (e.g. `tools/web.ts`) report a misleading size.
**Fix (described):** Recompute from the final markdown.

### BUG-11 (Low) — UTF-8 split on byte-cap truncation
**What:** The byte cap slices the last chunk at an arbitrary byte offset, then `toString("utf8")` can corrupt a multibyte char straddling the boundary (`web/fetch.ts:52-61`).
**Why it matters:** Truncated non-ASCII pages can end in a replacement char.
**Fix (described):** Use a streaming `TextDecoder` (buffers partial code points) or trim back to a code-point boundary.

### BUG-12 (Low) — Non-atomic attachment write
**What:** `putBuffer` does `fs.access` then `fs.writeFile` with no lock (`attachments/store.ts:36-40`); a concurrent `readBuffer` could observe a partially-written file.
**Why it matters:** Content is sha-addressed so the outcome is idempotent, but partial reads are possible.
**Fix (described):** Write to a temp file + atomic `rename`, or use the `wx` flag and ignore `EEXIST`.

### BUG-13 (Low) — Silent media drop on failed download
**What:** A caption-only message whose media download returns null (`channels/telegram.ts:124,158`) is published as text with the media silently dropped (warn-logged only).
**Why it matters:** Silent data loss with no user-visible signal.
**Fix (described):** Append a "[attachment failed to download]" note, or retry.

### BUG-14 (Low) — WhatsApp send ignores HTTP status
**What:** The outbound POST `.catch()`es network errors but never checks `res.ok` (`channels/whatsapp.ts:39-54`), so a 4xx/5xx (bad/expired token, rate-limit) is silently ignored.
**Why it matters:** Failed sends vanish with zero diagnostics, unlike the telegram path.
**Fix (described):** Check `res.ok` and log status+body on failure.

### BUG-15 (Low) — Bootstrap failures invisible to the turn
**What:** `await runSkillBootstraps(skills, dataDir)` discards the returned result map (`kernel/agent-turn.ts:99`), which carries exit codes / stderr tails.
**Why it matters:** A failed bootstrap (non-zero exit) is only logged; the skill loads without its binary and the failure is easy to miss.
**Fix (described):** Capture the map and surface a warning (skill menu or system note) for any non-zero/null exit.

### BUG-16 (Low) — Missing secrets silently become empty string
**What:** `expandEnv` resolves `${VAR}` to `""` when unset/empty and leaves no error for an unresolved reference (`config/load.ts:18-22`); the corresponding schema fields are `.optional()`.
**Why it matters:** A required secret referenced as `${TELEGRAM_BOT_TOKEN}` that is unset passes validation as `""`, surfacing only as a downstream auth failure.
**Fix (described):** Leave unresolved `${VAR}` intact (or throw) when no `:-` fallback is given, so missing secrets fail loudly.

### BUG-17 (Low) — Container leak on non-timeout failures
**What:** Only the `result.timedOut` branch issues `docker rm -f` (`dispatch/container.ts:100-121`); other failure/throw paths rely solely on `--rm`, which doesn't fire if the daemon/container is wedged or the supervisor dies mid-run.
**Why it matters:** Orphaned containers hold their mounts/resources.
**Fix (described):** Wrap dispatch in try/finally that best-effort `docker rm -f <name>` on every exit path.

### BUG-18 (Low) — Worker response trusted without validation
**What:** `return (await res.json()) as DispatchResult` casts the persistent worker's HTTP response with no shape check (`dispatch/persistent.ts:80`).
**Why it matters:** A malformed 200 propagates an untyped object downstream as if valid, surfacing as a confusing failure far from the cause.
**Fix (described):** Validate the parsed body against the `DispatchResult` union (zod or a `status` check) before returning.

---

## Detail — Dead code

All claims below were grep-verified across `src/` by the auditing pass; items touching runtime dispatch (string-keyed tool/registry lookups, route names, config lookups) were checked for dynamic references.

- **DEAD-01** `config/schema.ts:106` — `mcp.inline` is parsed but no code reads it (only `mcp.configPath` is consumed). A user setting `mcp.inline` is silently ignored. *Fix:* wire it into `loadMcpConfig` or remove it.
- **DEAD-02** `runtime/base.ts:12-14` — `ExecOptions.memory`/`cpus` are never set by any caller (`bash.ts`/`buildRuntime` don't populate them), so the limit branches in `DockerRuntime` are unreachable. Reinforces SEC-03. *Fix:* wire `config.runtime` limits through, or remove the fields.
- **DEAD-03** `channels/base.ts:51` — `OutgoingMessage.toExternalUserId` declared (and referenced in a `Channel.send` doc comment) but never read; routing uses the explicit `externalUserId` arg. *Fix:* remove the field and correct the doc comment.
- **DEAD-04** `brain/skills.ts:10,24` — `LoadedSkill.readOnly` is populated but never read (write-protection is enforced via `ToolContext.brainWritable` in `tools/file.ts`). *Fix:* remove the field (and the now-unused `writable` param if no other use).
- **DEAD-05** `brain/agents.ts:9,17`, `brain/commands.ts:33,42` — `sourcePath` set on both, zero readers. *Fix:* drop, or use it in error/log messages.
- **DEAD-06** `memory/base.ts:16-25`, `memory/brain-sync.ts:22` — neither existing backend (`MempalaceMcpBackend`, `NoopMemoryBackend`) implements `recent()`/`append()`, so `startBrainSync` always early-returns; the whole brain-sync write path is dead. *Fix:* implement `recent()` on the mempalace backend or gate/remove brain-sync. *(Needs-confirmation — verify no third backend exists.)*
- **DEAD-07** `config/schema.ts:149-171` — the `mempalace` config block is self-documented as deprecated and unread (the setup/export modules reference the MCP server *name*, not this block). Intentionally retained for back-compat validation; informational. *Fix:* leave until a config-version migration drops it.
- **DEAD-08** `attachments/whisper-provision.ts:11` — `whisperProvisionUrl` is exported but its only caller is in-module. *Fix:* drop the `export`.
- **DEAD-09** `brain/skill-bootstrap.ts:44-52` — `skillBinRoot`/`sharedBinDir`/`perSkillDir` exported with no external consumer (the bash tool recomputes its own skill-bin path). *Fix:* drop the `export`, or have the bash-tool PATH wiring reuse `sharedBinDir` for a single source of truth.

---

## Detail — Improvements

- **IMP-01 (Medium)** — `web/fetch.ts:22` and `kernel/ingest.ts:209` are two `fetchUrl`s with the same name but wildly different safety; consolidating into one hardened utility fixes SEC-05 in one place.
- **IMP-02 (Low)** — `originChannel`/`originExternalUserId` payload-threading is hand-rolled in all three dispatchers (`in-process.ts:12`, `container.ts:211`, `persistent.ts:30`); a new `DispatchArgs` field requires three edits. *Fix:* centralize arg→payload normalization.
- **IMP-03 (Low)** — Config/compose path-candidate lists are duplicated in `config/load.ts:36`, `install.ts:892`, `install.ts:1043` and already differ (load checks `.yml`/`.json`, install doesn't), so a location honored by the runtime may not be found by `dae install`. *Fix:* one shared `configCandidates()` helper.
- **IMP-04 (Low)** — All setup writers (`env-file.ts:41`, `yaml-edit.ts:13`, `mcp-edit.ts`) do direct `fs.writeFile` over the live file; an interrupted `dae install` can leave a half-written `.env`/config and lose merged-in secrets. `mcp-edit` additionally swallows parse errors to `{}`, wiping existing servers on the next upsert. *Fix:* shared `atomicWrite(path, data, {mode})` (temp + rename); surface (don't swallow) parse errors on a non-empty file.
- **IMP-05 (Low)** — `as`-casts at trust boundaries: `DispatchResult` (`persistent.ts:80`, `container.ts:252`), Telegram API responses (`telegram.ts:174,183`), provider image `media_type`/tool schema casts, the undici dispatcher cast (`mcp/client.ts:20`). *Fix:* validate with zod / type guards at each boundary (the project already uses zod).
- **IMP-06 (Low)** — `.md`-listing ("readdir → filter `.md` → strip ext → swallow to `[]`") is reimplemented in `agents.ts:20`, `commands.ts:48`, `skills.ts:64`, `composer.ts:9`; any traversal hardening (SEC-16) would need applying four times. *Fix:* extract `listMarkdownNames(dir)` + `safeJoinUnderBrain`.
- **IMP-07 (Low)** — Partial-delivery states (text sent, attachment failed) are invisible to the user on both telegram and whatsapp. *Fix:* append a short note or follow-up on attachment failure.
- **IMP-08 (Low)** — Adapters substitute placeholder keys (`openai.ts:33` `"no-key"`, `anthropic.ts:29` `""`, `index.ts:34` `"ollama"`), so a missing key surfaces only as a downstream 401 instead of at resolve time — weakening `resolveProviderKey`'s explicit check. *Fix:* let `resolveProviderKey` be the single source of truth and have adapters require a key.
- **IMP-09 (Low)** — `callMcpTool` forwards `input` to the server with no validation against the tool's advertised `inputSchema` (`mcp/client.ts:97-111`). *Fix:* validate before forwarding (defense in depth).
- **IMP-10 (Low)** — The static-cron fire path (`cron.ts:76-108`) builds ingest+dispatch but discards the agent's reply, while the runtime poller path (`poller.ts:107-156`) frames the prompt and delivers it. *Fix:* extract a shared `fireScheduledTurn` and decide deliberately whether static schedules should also deliver replies.

---

## Suggested action order

### Quick wins (small, high-value, low-risk)
1. **SEC-08** — `chmod 600` secret files + `0o700` dirs (one helper, a few call sites).
2. **SEC-06** — Allowlist the `schedule_message` `agent` arg (a few lines in `tools/schedule.ts`).
3. **SEC-01** — Add a channel sender allowlist (config field + one guard in `handleMessage`); fail closed.
4. **SEC-12** — Attribute-escape + scheme-allowlist link hrefs in the Telegram formatter.
5. **BUG-03 / BUG-02** — Pass a timezone to croner; anchor recurring fires on `due_at`.
6. **BUG-04** — Add fire-attempt backoff / dead-letter so a poison schedule can't hot-loop.
7. **BUG-05** — Flip `streaming` to `false` until real streaming exists.
8. **BUG-14 / BUG-13 / BUG-15** — Surface silent failures (whatsapp `res.ok`, dropped media, bootstrap results).
9. **DEAD-01/03/04/05/08/09** — Delete the confirmed dead fields/exports (and decide on `mcp.inline`).
10. **SEC-10** — Disable gray-matter's JS engine at the three `matter()` call sites.

### Larger efforts (design/structural)
1. **SEC-02** — Replace the raw docker.sock mount with a restricted socket proxy or gated opt-in. *Highest-value structural change.*
2. **SEC-03 + DEAD-02** — Add container hardening flags and wire real memory/CPU/PID limits through `buildRuntime` → `DockerRuntime`.
3. **SEC-04 + SEC-05 + IMP-01** — Build one hardened fetch utility (SSRF blocklist, manual bounded redirects, byte cap, timeout) and use it for both web and attachment fetches; add SEC-15 (MCP URL) and SEC-17 (DDG) to the same guard.
4. **SEC-07 + SEC-11** — Replace `...process.env` spreads to MCP stdio children and bootstrap scripts with explicit env allowlists.
5. **SEC-09** — Move docker-run secret forwarding off argv (`--env-file` / inherited `-e KEY`).
6. **BUG-01 + IMP-05** — Sentinel-frame the DispatchResult and validate all cross-process JSON with zod.
7. **SEC-13** — Add artifact integrity verification to `dae update`.
8. **IMP-02/03/04/06** — Consolidate the duplicated dispatch-payload, config-candidate, atomic-write, and md-listing helpers (also enables SEC-16 hardening in one place).

---

### Notes on what was checked and found sound
- Host-side command construction in the docker dispatcher and `DockerRuntime` is **not** shell-injectable: argv is built as a discrete array and passed to `execa` with no `shell:true`; only the *container's* `/bin/sh -c` interprets the agent command (intended). `HostRuntime` deliberately uses `shell:true` — correct for host mode, but means a host-runtime agent's bash runs unsandboxed by design.
- Web-channel auth (`web-auth.ts`): scrypt hashing, HMAC session cookies, and `timingSafeEqual` comparisons are implemented correctly; login derives the user from the cookie (clients can't impersonate). Conversation-ownership checks in `web.ts` are enforced consistently (`resolveConversation`, the `/conversations` handlers).
- The session/schedule stores' inode-reopen guard, atomic DDL migration (`execAtomic`), and rowid-ordered `tail()` are sound.
- `install.ts` logs secret *names* only, not values; the Graphiti token print at `install.ts:684` is deliberate and documented.
- Telegram poll-loop ordering/offset advancement correctly prevents replay; the markdown/table regexes were probed and don't catastrophically backtrack.
