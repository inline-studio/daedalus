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
  inline: z.record(z.unknown()).optional(), // { servers: { name: { command, args, env, transport } } }
});
export type McpConfig = z.infer<typeof McpConfigSchema>;

export const MemoryConfigSchema = z.object({
  backend: z.enum(["none", "mempalace", "graphiti", "sqlite"]).default("none"),
  brainSync: z
    .object({
      enabled: z.boolean().default(false),
      schedule: z.string().default("0 */6 * * *"),
      path: z.string().optional(),
    })
    .default({ enabled: false, schedule: "0 */6 * * *" }),
});
export type MemoryConfig = z.infer<typeof MemoryConfigSchema>;

// Mempalace deployment options — only relevant when memory.backend = mempalace AND you've
// chosen the "local-http" mode in setup. Tells the service-install wizard how to spawn
// mempalace as a managed daemon that other machines on your LAN can also reach.
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
});
export type SessionsConfig = z.infer<typeof SessionsConfigSchema>;

export const ChannelsConfigSchema = z.object({
  cli: z.object({ enabled: z.boolean().default(false), defaultAgent: z.string() }).optional(),
  web: z
    .object({
      enabled: z.boolean().default(false),
      defaultAgent: z.string(),
      port: z.number().int().min(1).max(65535).optional(),
      token: z.string().optional(),
    })
    .optional(),
  telegram: z
    .object({
      enabled: z.boolean().default(false),
      defaultAgent: z.string(),
      token: z.string(),
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
    })
    .default({ maxBytes: 1_000_000, timeoutMs: 20_000 }),
});
export type WebConfig = z.infer<typeof WebConfigSchema>;

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
});
export type ArtemisConfig = z.infer<typeof ArtemisConfigSchema>;

// Per-agent manifest, parsed from frontmatter of brain/agents/*.md.
export const AgentContainerSchema = z.object({
  image: z.string(),
  workdir: z.string().default("/workspace"),
  bind: z.array(z.string()).default([]), // "host:container[:ro]"
  env: z.record(z.string()).default({}),
  network: z.string().optional(),
});
export type AgentContainer = z.infer<typeof AgentContainerSchema>;

export const AgentManifestSchema = z.object({
  name: z.string(),
  description: z.string().default(""),
  provider: z.enum(["anthropic", "openai", "ollama"]),
  model: z.string(),
  maxTurns: z.number().int().positive().default(50),
  maxTokens: z.number().int().positive().default(4096),
  temperature: z.number().min(0).max(2).optional(),
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
  souls: z.array(z.string()).default([]),
  personas: z.array(z.string()).default([]),
  standards: z.array(z.string()).default([]).optional(), // empty = include all
  operations: z.array(z.string()).default([]).optional(), // empty = include all
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
  // Secret names that must be resolvable (via env or the SecretsBackend) when this skill is loaded.
  // Surfaced as a clear warning at agent start time if missing.
  requires: z
    .object({
      secrets: z.array(z.string()).default([]),
    })
    .default({ secrets: [] }),
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;
