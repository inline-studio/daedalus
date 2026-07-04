import { z } from "zod";

// Top-level runner config. Loaded from daedalus.config.yaml or .json.
// Env-var interpolation (${VAR}) is performed before validation.

export const ProvidersConfigSchema = z.object({
  anthropic: z
    .object({
      apiKey: z.string().optional(),
      baseUrl: z.string().url().optional(),
    })
    .optional(),
  openai: z
    .object({
      apiKey: z.string().optional(),
      baseUrl: z.string().url().optional(),
    })
    .optional(),
  ollama: z
    .object({
      baseUrl: z.string().url().default("http://localhost:11434"),
    })
    .optional(),
});
export type ProvidersConfig = z.infer<typeof ProvidersConfigSchema>;

export const RuntimeConfigSchema = z.object({
  // Where the bash tool runs is inferred per-agent: an agent with a container.image
  // gets a docker runtime (bash in that image); otherwise bash runs in the current
  // process — which, inside a dispatched agent container, IS that container.
  // How the supervisor runs each agent turn:
  //   "container" — (default) spawns a fresh docker container per agent turn via the
  //                 mounted docker.sock; subagents recurse the same way. The supported
  //                 deployment — docker-compose sets DAE_DISPATCHER=docker.
  //   "process"   — in-process, no container. A non-docker fallback for `dae serve`
  //                 (and in-process subagent delegation); the supported deployment is docker.
  // Overridable at runtime via the DAE_DISPATCHER env var (set by docker-compose).
  dispatcher: z.enum(["process", "container"]).default("container"),
  // When true, the supervisor routes each top-level turn to a long-lived "warm" agent
  // worker container (`dae agent-worker`) over HTTP instead of spawning a fresh
  // container per message. The worker keeps OneCLI + MCP connections warm, so turns
  // skip the container cold-start; subagents still spawn ephemeral containers. Set by
  // `dae install` (the docker stack provides the dae-worker service); the worker URL
  // comes from DAE_WORKER_URL. Leave false for non-docker `dae serve`.
  persistentAgent: z.boolean().default(false),
  docker: z
    .object({
      // Path to the docker binary. If unset, the runtime tries `docker` on PATH and
      // falls back to env DOCKER_BIN. Set this when docker is installed in a non-standard
      // location and isn't on PATH for the runner process.
      bin: z.string().optional(),
      socket: z.string().optional(), // e.g. unix:///var/run/docker.sock or npipe:////./pipe/docker_engine
      defaultNetwork: z.string().optional(),
    })
    .optional(),
  // Cross-agent persistent storage. Mounted writable into every Docker agent at
  // `containerPath` (default /shared); also exposed to host-runtime agents via the
  // ARTEMIS_SHARED env var. Survives container exits — it's a host bind, not a Docker volume.
  shared: z
    .object({
      enabled: z.boolean().default(true),
      hostPath: z.string().default("./data/shared"),
      containerPath: z.string().default("/shared"),
    })
    .default({ enabled: true, hostPath: "./data/shared", containerPath: "/shared" }),
  // Live subagent event streaming. When true (default), a dispatcher with a live event
  // sink asks spawned agent-turn containers to stream their TurnEvents back over stdout
  // (DAE_EVENT_STREAM=ndjson), so streaming surfaces show delegated work as it happens.
  // Turn off to keep subagent turns opaque (buffered final-result-only, the old behaviour).
  subagentEventStream: z.boolean().default(true),
  // SEC-03: default resource limits applied to EVERY agent container. Deliberately
  // CONSERVATIVE (1 CPU / 1 GB / 512 pids) so a runaway agent can't starve co-located
  // services or take down the host — an agent that needs more raises them in its own
  // `container:` frontmatter. cap-drop=ALL + no-new-privileges are always on (not configurable).
  limits: z
    .object({
      memory: z.coerce.string().default("1g"), // docker --memory
      cpus: z.coerce.string().default("1"), // docker --cpus (string permits "1.5")
      pidsLimit: z.coerce.number().int().positive().default(512), // docker --pids-limit
    })
    .default({ memory: "1g", cpus: "1", pidsLimit: 512 }),
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

// OneCLI v1.x is a credential-injecting HTTPS-MITM gateway. At startup we call
// GET <baseUrl>/api/container-config?agent=<agent> via the official @onecli-sh/sdk;
// the response carries the proxy URL, the env vars to set, and OneCLI's MITM CA cert.
// The proxy URL and CA are NOT configured here — they come from the gateway itself,
// so this stays correct across OneCLI versions and per-install CA regeneration.
export const OneCliConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Dashboard / REST URL. Defaults to the standard OneCLI Docker compose port.
  baseUrl: z.string().url().default("http://localhost:10254"),
  // OneCLI agent identifier — selects which agent's policy + assigned secrets apply.
  // Create one with `onecli agents create --name Daedalus --identifier daedalus`.
  agent: z.string().default("daedalus"),
  // Daemon API key (oc_...). Resolution order at runtime:
  //   1. this field   2. process.env.ONECLI_API_KEY   3. ~/.onecli/credentials/api-key
  // NOT the per-agent token (aoc_...); the SDK auths with the user key and selects
  // the agent via query string.
  apiKey: z.string().optional(),
});
export type OneCliConfig = z.infer<typeof OneCliConfigSchema>;

export const SecretsConfigSchema = z.object({
  // 'auto' picks OneCLI if reachable, else env-file. 'env-file' is the always-available fallback.
  backend: z.enum(["auto", "onecli", "env-file"]).default("auto"),
  envFile: z
    .object({ path: z.string().default(".env.local") })
    .default({ path: ".env.local" }),
  onecli: z
    .object({
      baseUrl: z.string().url().default("http://localhost:10254"),
      token: z.string().optional(),
    })
    .default({ baseUrl: "http://localhost:10254" }),
});
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;

export const McpConfigSchema = z.object({
  configPath: z.string().optional(), // file or directory of *.json
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

export const MemoryConfigSchema = z.object({
  // "mempalace" is DEPRECATED — it's been removed from the stack (Graphiti is the memory
  // backend now). The value is kept only so configs written by an older `dae install`
  // still validate; it's no longer wired up. `dae install` writes "graphiti".
  backend: z.enum(["none", "mempalace", "graphiti", "sqlite"]).default("none"),
  brainSync: z
    .object({
      enabled: z.boolean().default(false),
      schedule: z.string().default("0 */6 * * *"),
      path: z.string().optional(),
    })
    .default({ enabled: false, schedule: "0 */6 * * *" }),
  // Deterministic auto-save. After each TOP-LEVEL (user-facing) turn, a small extraction
  // call distils any durable facts — stated preferences, decisions, commitments, stable
  // personal/project facts, concrete outcomes — from the turn and writes each to the memory
  // backend via its add tool. This is the "curator" stage in front of Graphiti's own
  // ingestion LLM: it decides IF and WHAT is worth remembering so the graph isn't polluted
  // with ephemeral chatter; Graphiti then structures each saved episode into entities/edges.
  // Active only when a memory MCP server is connected (i.e. graphiti.enabled). Subagent turns
  // are never auto-saved (their findings flow up to the orchestrator's turn).
  autoSave: z
    .object({
      enabled: z.boolean().default(true),
      // Optional model override for the extraction call, used with the AGENT'S provider.
      // Leave unset to reuse the agent's own model. Point it at a cheaper/faster model on
      // the same gateway (e.g. a small spark model) to keep the per-turn overhead low.
      model: z.string().optional(),
      // Upper bound on facts saved per turn — a backstop against a runaway extraction.
      maxFactsPerTurn: z.number().int().positive().default(8),
    })
    .default({ enabled: true, maxFactsPerTurn: 8 }),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

// Skill self-learning: the post-turn review pass that lets the agent create/patch its own
// skills (via the skill_manage tool), plus the staleness curator that ages unused
// agent-created skills out. Off by default — turning it on also requires `brain.writable:
// true` (skill_manage refuses to write otherwise).
export const SkillsConfigSchema = z.object({
  learning: z
    .object({
      enabled: z.boolean().default(false),
      // Optional model override for the review pass, used with the AGENT'S provider. Leave
      // unset to reuse the agent's own model — same model means the review replays a warm
      // prompt-cache prefix, so the pass is cheap.
      model: z.string().optional(),
      // Run the review only after substantial turns: at least this many tool calls, OR a
      // skill was loaded this turn, OR the accumulated per-session nudge counter (below)
      // crossed its threshold. Keeps trivial turns from paying an extra LLM call.
      minToolCalls: z.number().int().positive().default(5),
      // Cross-turn backstop: total tool calls accumulated in a session since the last
      // skill_manage use; crossing it arms the next review even for small turns.
      nudgeInterval: z.number().int().positive().default(10),
      // When true (the default), skill_manage stages every create/patch under
      // skills/.pending/ for human review (`dae skill pending|approve|reject`) instead of
      // writing live. Turn off once the generated skills have earned trust.
      writeApproval: z.boolean().default(true),
      // Tool-loop budget for one review pass (it's a mini agent turn with only skill_manage).
      maxReviewTurns: z.number().int().positive().default(6),
      curator: z
        .object({
          enabled: z.boolean().default(true),
          // When the curator sweep runs (cron, supervisor timezone).
          schedule: z.string().default("0 4 * * 0"),
          // Agent-created skills unused for this long are marked status: stale…
          staleAfterDays: z.number().int().positive().default(30),
          // …and this long moves them to skills/.archive/ (never deleted).
          archiveAfterDays: z.number().int().positive().default(90),
        })
        .default({ enabled: true, schedule: "0 4 * * 0", staleAfterDays: 30, archiveAfterDays: 90 }),
    })
    .default({}),
});
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>;

// DEPRECATED. MemPalace has been removed from the daedalus stack (Graphiti is the memory
// backend — see GraphitiConfigSchema). This schema is retained only so older configs that
// still carry a `mempalace:` block validate; `dae install` no longer writes it and the
// auto-injected memory MCP no longer reads it. The `dae export mempalace` command remains
// for migrating data OUT of an existing palace.
export const MempalaceConfigSchema = z.object({
  localHttp: z
    .object({
      enabled: z.boolean().default(false),
      command: z.string().default("uvx"),
      args: z.array(z.string()).default(["mempalace-mcp"]),
      // Bind address. 127.0.0.1 = local only; 0.0.0.0 = reachable from your LAN/WAN.
      // ALWAYS set a token if binding to 0.0.0.0.
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(11364),
      // Path the MCP HTTP transport is served on. Most servers default to /mcp.
      urlPath: z.string().default("/mcp"),
    })
    .default({
      enabled: false,
      command: "uvx",
      args: ["mempalace-mcp"],
      host: "127.0.0.1",
      port: 11364,
      urlPath: "/mcp",
    }),
});
export type MempalaceConfig = z.infer<typeof MempalaceConfigSchema>;

// Graphiti temporal-knowledge-graph memory (the `graphiti` compose service). When enabled
// it's auto-injected as every agent's `memory` MCP server, reached by name on the daedalus
// network. The store + embeddings are local; extraction runs on your spark endpoint.
export const GraphitiConfigSchema = z.object({
  enabled: z.boolean().default(false),
  url: z.string().default("http://graphiti:8000/mcp/"),
  // OPTIONAL remote access over MCP. When enabled, `dae install` publishes the Graphiti
  // MCP port to a host port (bind:port) so you can reach the memory server from another
  // machine THROUGH YOUR OWN reverse proxy (which adds TLS + auth). Graphiti itself has
  // NO authentication — the proxy MUST enforce the bearer token (`dae install` generates
  // one and stores it as GRAPHITI_REMOTE_TOKEN in the compose .env; it prints the matching
  // Caddy config + the remote MCP URL/token at the end). `bind` defaults to 127.0.0.1
  // (loopback — correct when the proxy runs on the same host); set it to 0.0.0.0 only if
  // the proxy runs elsewhere. The token lives in the compose .env, never here.
  remote: z
    .object({
      enabled: z.boolean().default(false),
      host: z.string().default("127.0.0.1"),
      port: z.number().int().min(1).max(65535).default(8000),
    })
    .default({ enabled: false, host: "127.0.0.1", port: 8000 }),
});
export type GraphitiConfig = z.infer<typeof GraphitiConfigSchema>;

export const SessionsConfigSchema = z.object({
  dbPath: z.string().default("./data/sessions.sqlite"),
  attachmentsPath: z.string().default("./data/attachments"),
  // Max prior messages to load per turn (a count bound on the DB query).
  historyLimit: z.number().int().positive().default(40),
  // OPTIONAL proactive trim. When set, the replayed history is trimmed (oldest-first) to
  // this estimated-token budget BEFORE each turn. Leave it UNSET (the default) so daedalus
  // doesn't bake in an assumption about the model's context window — it adapts at runtime,
  // trimming/compacting reactively when the provider reports the window is full, whatever
  // that window is. Set this only to avoid the occasional reactive round-trip on a model
  // whose (small) context you already know. ~4 chars/token.
  contextTokenBudget: z.number().int().positive().optional(),
  // Once an agent finishes a turn-loop (final text-only assistant message, no more tool_use),
  // the trial-and-error that led to it has already been distilled into that final text — so
  // the bulky tool_result bodies in the chain are redundant. At replay time we strip them
  // from older loops, keeping the N most recent at full fidelity (so follow-ups that need
  // detail still work). 0 disables the compaction; the persisted history is never mutated —
  // this is purely a view applied before each turn. Default: 2 (current + previous loop).
  keepFullFidelityLoops: z.number().int().min(0).default(2),
  // Web conversations only: after the first exchange in a NEW (non-default) conversation, ask
  // the model for a short title for it (shown in the web UI's conversation list), replacing the
  // provisional first-message snippet. Best-effort and non-fatal. Set false to keep the snippet.
  autoTitle: z.boolean().default(true),
  // Optional model override for the title call (used with the agent's provider). Leave unset
  // to reuse the agent's own model. On a REASONING model this should point at a small,
  // NON-thinking model on the same gateway (e.g. the same one as memory.autoSave.model) —
  // otherwise the tiny title token budget is spent inside a <think> block and the title comes
  // back empty, leaving the provisional first-message snippet in place.
  titleModel: z.string().optional(),
  // Persistent catalogue of every attachment a user uploads, so the assistant can re-reference
  // a file in a later session (via the find_attachment tool) without the user re-sending it.
  // The bytes already persist in the content-addressable AttachmentStore; this is purely the
  // discoverability index over them. Local-only (rides the sessions sqlite, no egress) and
  // cheap, so it's on by default; set enabled:false to skip indexing and hide find_attachment.
  attachmentIndex: z
    .object({
      enabled: z.boolean().default(true),
    })
    .default({ enabled: true }),
});
export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;

// Operator-facing debugging aids. All OFF by default — these capture full prompt/tool
// I/O to disk, so they're opt-in and meant for a single-operator deployment, not a
// privacy-sensitive multi-tenant one.
export const DebugConfigSchema = z.object({
  // Per-turn conversation trace. When enabled, every agent turn (top-level AND subagent)
  // appends a structured JSONL record — the exact messages exchanged this turn, including
  // every tool_use (name + args) and tool_result (output), plus usage and stop reason — to
  // <path>/<sessionId>__<date>.jsonl. This is the empirical answer to "did the agent actually
  // run that tool, or did it make the result up?": a claim with no preceding tool_use in the
  // trace was a hallucination. Files older than retentionDays are pruned on each write.
  conversationLog: z
    .object({
      enabled: z.boolean().default(false),
      // Drop trace files whose last write is older than this many days. Bounds disk use and
      // keeps the on-disk window small (the logs hold full prompts + tool I/O).
      retentionDays: z.number().int().positive().default(5),
      // Directory for the JSONL files. In docker installs this should point inside the mounted
      // data volume (e.g. /data/debug-logs) so it survives container recreation — `dae install`
      // writes the absolute path, mirroring sessions.dbPath.
      path: z.string().default("./data/debug-logs"),
    })
    .default({ enabled: false, retentionDays: 5, path: "./data/debug-logs" }),
});
export type DebugConfig = z.infer<typeof DebugConfigSchema>;

// Live token streaming to channels that support it (currently web + CLI; Telegram stays buffered
// by design). Global on/off escape hatch: when a backend's streaming is flaky (e.g. an
// OpenAI-compatible gateway that mishandles stream:true or doesn't emit reasoning deltas), set
// enabled:false to fall back to buffered replies everywhere without a code change. Per-provider
// support is still required — this only gates whether the supervisor engages a channel's stream.
export const StreamingConfigSchema = z.object({
  enabled: z.boolean().default(true),
});
export type StreamingConfig = z.infer<typeof StreamingConfigSchema>;

export const ChannelsConfigSchema = z.object({
  cli: z
    .object({
      enabled: z.boolean().default(false),
      defaultAgent: z.string(),
      // How much live subagent activity to print: "summary" (default — spawn, tool names,
      // completion), "full" (also each subagent's final reply text), "off" (opaque spawns).
      subagentEvents: z.enum(["summary", "full", "off"]).default("summary"),
    })
    .optional(),
  web: z
    .object({
      enabled: z.boolean().default(false),
      defaultAgent: z.string(),
      port: z.number().int().min(1).max(65535).optional(),
      token: z.string().optional(),
      // Built-in login (username/password). When username + passwordHash + sessionSecret are
      // all set, the UI gets its own /login page + signed-cookie auth and the bearer token is
      // ignored — so you don't need the reverse proxy's basic_auth. Values resolve from
      // .env.local (passwordHash is an scrypt hash, never the raw password); `dae install`
      // wires these up.
      username: z.string().optional(),
      passwordHash: z.string().optional(),
      sessionSecret: z.string().optional(),
      // Display name for the human in the "copy conversation" transcript (the attributed,
      // Telegram-style `[date] Name: …` export). Falls back to the logged-in username
      // (login mode) or "You". Set this to e.g. your full name for nicer debug pastes.
      userName: z.string().optional(),
      // Which clients get the chat UI shell. "browser" (default): anyone who can reach
      // the port. "desktop-only": browsers get a download page instead — the UI loads
      // only inside the Daedalus desktop app (which identifies itself per request).
      // The API surface (/messages, /events, /rpc/*, …) is identical in both modes and
      // is what the desktop app, `dae`, and executors speak; auth is unchanged. This is
      // a UI-surface gate, not a security boundary.
      ui: z.enum(["browser", "desktop-only"]).default("browser"),
      // Remote execution (the `dae remote` CLI): a laptop-side client connects an
      // outbound SSE stream and becomes the EXECUTOR for its user's turns — bash and
      // read/write/edit run on the laptop instead of the agent container. Off by
      // default; turns from users without a connected executor are unaffected either way.
      remoteExec: z
        .object({
          enabled: z.boolean().default(false),
          // Per-request cap on how long the server waits for the laptop to return a
          // result (the client enforces the command's own timeout separately).
          timeoutMs: z.number().int().positive().default(180_000),
          // Where agent containers reach the supervisor's internal /rpc/exec bridge.
          // Defaults per dispatch mode (http://daedalus:<port> in docker,
          // http://127.0.0.1:<port> in-process); set for non-standard topologies.
          internalUrl: z.string().optional(),
        })
        .default({}),
    })
    .optional(),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      defaultAgent: z.string(),
      token: z.string(),
      // Sender allowlist (fail-closed). Only these Telegram chat ids may drive the agent;
      // UNSET or empty ⇒ ALL inbound messages are rejected. Find your id via @userinfobot.
      allowedChatIds: z.array(z.coerce.string()).optional(),
    })
    .optional(),
  whatsapp: z
    .object({
      enabled: z.boolean().default(false),
      defaultAgent: z.string(),
      accessToken: z.string(),
      phoneNumberId: z.string(),
    })
    .optional(),
});
export type ChannelsConfig = z.infer<typeof ChannelsConfigSchema>;

export const TranscribeConfigSchema = z.object({
  backend: z.enum(["none", "openai-whisper", "whisper-local"]).default("none"),
  apiKey: z.string().optional(),
  baseUrl: z.string().url().optional(),
  model: z.string().optional(),
});
export type TranscribeConfig = z.infer<typeof TranscribeConfigSchema>;

export const WebConfigSchema = z.object({
  // web_fetch is always available (no provider needed). web_search needs a provider.
  search: z
    .object({
      provider: z.enum(["none", "duckduckgo", "brave"]).default("none"),
      apiKey: z.string().optional(),
    })
    .default({ provider: "none" }),
  fetch: z
    .object({
      // Hard cap on bytes downloaded per fetch. Above this, body is truncated.
      maxBytes: z.number().int().positive().default(1_000_000),
      timeoutMs: z.number().int().positive().default(20_000),
      userAgent: z.string().optional(),
      // SEC-04: web_fetch blocks private/loopback/link-local/metadata destinations by default.
      // List exact hostnames here to explicitly permit an internal host (e.g. a self-hosted
      // service the agent must reach via web_fetch). Empty = deny all internal.
      allowHosts: z.array(z.string()).default([]),
    })
    .default({ maxBytes: 1_000_000, timeoutMs: 20_000 }),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;

// Limits for fetching inbound attachments supplied as a URL (rather than inline bytes).
// SEC-05: the attachment fetch is SSRF-guarded (reusing web.fetch.allowHosts), size-capped,
// and time-bounded. The cap defaults high enough for images/PDFs; raise it for video stores.
export const AttachmentsConfigSchema = z.object({
  maxFetchBytes: z.number().int().positive().default(25_000_000), // 25 MB
  fetchTimeoutMs: z.number().int().positive().default(30_000),
});
export type AttachmentsConfig = z.infer<typeof AttachmentsConfigSchema>;

export const BrainConfigSchema = z.object({
  path: z.string(),
  writable: z.boolean().default(false),
});
export type BrainConfig = z.infer<typeof BrainConfigSchema>;

// User-facing identity for the orchestrator. From the user's perspective, only ONE thing
// answers them — and it has a name. Subagents stay invisible behind it.
export const IdentityConfigSchema = z.object({
  // The name the orchestrator refers to itself by, and how the user addresses it.
  name: z.string().default("Artemis"),
  // Optional shorter / informal nickname; used in transcript displays. Defaults to `name`.
  nickname: z.string().optional(),
});
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;

export const ArtemisConfigSchema = z.object({
  brain: BrainConfigSchema,
  identity: IdentityConfigSchema.default({ name: "Artemis" }),
  providers: ProvidersConfigSchema.default({}),
  runtime: RuntimeConfigSchema.default({}),
  onecli: OneCliConfigSchema.default({
    enabled: false,
    baseUrl: "http://localhost:10254",
    agent: "daedalus",
  }),
  secrets: SecretsConfigSchema.default({
    backend: "auto",
    envFile: { path: ".env.local" },
    onecli: { baseUrl: "http://localhost:10254" },
  }),
  mcp: McpConfigSchema.default({}),
  memory: MemoryConfigSchema.default({ backend: "none", brainSync: { enabled: false, schedule: "0 */6 * * *" } }),
  skills: SkillsConfigSchema.default({}),
  mempalace: MempalaceConfigSchema.default({
    localHttp: {
      enabled: false,
      command: "uvx",
      args: ["mempalace-mcp"],
      host: "127.0.0.1",
      port: 11364,
      urlPath: "/mcp",
    },
  }),
  graphiti: GraphitiConfigSchema.default({ enabled: false, url: "http://graphiti:8000/mcp/" }),
  sessions: SessionsConfigSchema.default({
    dbPath: "./data/sessions.sqlite",
    attachmentsPath: "./data/attachments",
    historyLimit: 40,
  }),
  channels: ChannelsConfigSchema.default({}),
  transcribe: TranscribeConfigSchema.default({ backend: "none" }),
  web: WebConfigSchema.default({
    search: { provider: "none" },
    fetch: { maxBytes: 1_000_000, timeoutMs: 20_000 },
  }),
  attachments: AttachmentsConfigSchema.default({}),
  debug: DebugConfigSchema.default({
    conversationLog: { enabled: false, retentionDays: 5, path: "./data/debug-logs" },
  }),
  streaming: StreamingConfigSchema.default({ enabled: true }),
});
export type ArtemisConfig = z.infer<typeof ArtemisConfigSchema>;

// Per-agent manifest, parsed from frontmatter of brain/agents/*.md.
export const AgentContainerSchema = z.object({
  image: z.string(),
  workdir: z.string().default("/workspace"),
  bind: z.array(z.string()).default([]), // "host:container[:ro]"
  env: z.record(z.string()).default({}),
  network: z.string().optional(),
  // SEC-03: per-agent resource overrides. Omit to inherit the conservative global defaults
  // (runtime.limits → 1 CPU / 1 GB / 512 pids). Raise for heavy leaves (builds, media).
  memory: z.coerce.string().optional(), // docker --memory, e.g. "4g"
  cpus: z.coerce.string().optional(), // docker --cpus, e.g. "2"
  pidsLimit: z.coerce.number().int().positive().optional(),
});
export type AgentContainer = z.infer<typeof AgentContainerSchema>;

// SEC-03: resolve a container's effective resource limits — a per-agent `container:` override
// falls back to the conservative global defaults (runtime.limits). Used by both container
// launch paths (the per-turn dispatcher container and the host-mode DockerRuntime).
export interface ResolvedLimits {
  memory: string;
  cpus: string;
  pidsLimit: number;
}
export function resolveContainerLimits(
  container:
    | { memory?: string | undefined; cpus?: string | undefined; pidsLimit?: number | undefined }
    | undefined,
  defaults: ResolvedLimits,
): ResolvedLimits {
  return {
    memory: container?.memory ?? defaults.memory,
    cpus: container?.cpus ?? defaults.cpus,
    pidsLimit: container?.pidsLimit ?? defaults.pidsLimit,
  };
}

export const AgentManifestSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  provider: z.enum(["anthropic", "openai", "ollama"]),
  model: z.string(),
  maxTurns: z.number().int().positive().default(50),
  maxTokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).optional(),
  // The model's context window in tokens — powers the web UI's context readout
  // (65.0k/256.0k · 25%). Optional: well-known model families are inferred (see
  // providers/model-info.ts); set this for LiteLLM aliases and local models. When neither
  // is known the UI shows a plain token count instead of a percentage.
  contextWindow: z.number().int().positive().optional(),
  // Where this agent's tools execute when spawned as a SUBAGENT:
  //   "server"   — (default) the usual container/worker placement.
  //   "executor" — REQUIRES the user's machine: the parent turn's connected executor
  //                (`dae remote` / the desktop app). For sub-agents whose tooling lives
  //                on the host (host-only CLIs, local projects). Spawning one without a
  //                connected executor fails fast with a clear message. Top-level turns
  //                ignore this — their placement is the per-conversation toggle.
  execution: z.enum(["server", "executor"]).default("server"),
  // Model reasoning ("thinking").
  //   enabled      — request Anthropic extended thinking (budget_tokens). ANTHROPIC ONLY: the
  //                  OpenAI-compatible path emits reasoning on its own, so this flag is ignored
  //                  there for the request — reasoning is still captured if the backend returns
  //                  it (reasoning_content field or inline <think> tags).
  //   budgetTokens — thinking budget; must be ≥1024 and < maxTokens (the provider clamps it).
  //                  When thinking is on, the API ignores `temperature`.
  //   surface      — bubble each turn's thinking up to the user as its own message(s) before the
  //                  reply (the persona "thinking out loud"). Off = thinking is captured to the
  //                  debug log but not shown.
  thinking: z
    .object({
      enabled: z.boolean().default(false),
      budgetTokens: z.number().int().min(1024).default(2048),
      surface: z.boolean().default(false),
    })
    .default({ enabled: false, budgetTokens: 2048, surface: false }),
  // Image input. Omit / false = no vision (inbound images are not sent to the model).
  // true = the agent's own `model` is multimodal; send images to it. "provider/model" =
  // route image-bearing turns to that specific vision model while text turns keep using
  // `model`. Lets vision work regardless of whether the deployment's main model can see.
  vision: z.union([z.boolean(), z.string()]).default(false),
  container: AgentContainerSchema.optional(),
  mcpServers: z.array(z.string()).default([]), // names from mcp config
  skills: z.array(z.string()).default([]),
  // Slash-commands the agent can invoke (e.g. `/ship`). Loaded from
  // <brain>/commands/<name>.md. `['*']` = all commands in the brain; named
  // list = subset; omit = none (the default — typical for subagents).
  // Recommended for the orchestrator: `commands: ['*']`.
  commands: z.array(z.string()).default([]),
  // For souls/personas/standards/operations: empty/omitted = include ALL files in that brain dir;
  // a named subset = only those; ["none"] = include NOTHING (the explicit opt-out — e.g. an
  // orchestrator that doesn't need the coding standards can set standards: ["none"]).
  souls: z.array(z.string()).default([]),
  personas: z.array(z.string()).default([]),
  standards: z.array(z.string()).default([]).optional(),
  operations: z.array(z.string()).default([]).optional(),
  subagents: z.array(z.string()).default([]),
  tools: z.array(z.string()).default([]), // built-in tool names: bash, read, write, edit, glob, grep
  // Inject the current date/time into the system prompt on every turn so the agent
  // never falls back to "today" assumptions. Disable only if you specifically need
  // the model to be timeless (e.g., reproducing deterministic answers).
  timeAware: z.boolean().default(true),
  // IANA timezone override (e.g. "Europe/London"). Defaults to system timezone.
  timezone: z.string().optional(),
});
export type AgentManifest = z.infer<typeof AgentManifestSchema>;

// Skill manifest: SKILL.md frontmatter.
export const SkillManifestSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  version: z.string().default("0.0.0"),
  // Built-in tools this skill needs at run time (e.g. ['web_search', 'web_fetch']).
  // The runner verifies each is in the agent's tool list before invoking the agent.
  toolsRequired: z.array(z.string()).default([]),
  // Plain phrases (e.g. "good night") that deterministically surface this skill.
  // When a user message contains one — whole-word, case/punctuation-insensitive —
  // ingest prepends a preamble telling the agent to load the skill and act on the
  // message. Triggers route; they never bypass the model, so mixed messages still
  // get a full turn. The skill description should keep naming the phrases too, for
  // the fuzzy variants exact matching can't catch.
  triggers: z.array(z.string()).default([]),
  // Secret names that must be resolvable (via env or the SecretsBackend) when this skill is loaded.
  // Surfaced as a clear warning at agent start time if missing.
  requires: z
    .object({
      secrets: z.array(z.string()).default([]),
    })
    .default({ secrets: [] }),
  // Who authored this skill. "agent" marks skills created by the skill-learning review pass
  // (via skill_manage); the staleness curator only ever touches those — human-authored skills
  // (the default, since existing SKILL.md files carry no origin) are never auto-transitioned.
  origin: z.enum(["human", "agent"]).default("human"),
  // Lifecycle state, managed by the curator: "stale" (unused past the threshold) demotes the
  // skill in the system-prompt menu; archival moves the whole directory to skills/.archive/.
  status: z.enum(["active", "stale"]).default("active"),
  // Pinned skills are exempt from every curator transition (never marked stale or archived).
  pinned: z.boolean().default(false),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
