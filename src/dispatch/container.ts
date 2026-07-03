import { execa } from "execa";
import path from "node:path";
import readline from "node:readline";
import type { ArtemisConfig, ResolvedLimits } from "../config/schema.js";
import { resolveContainerLimits } from "../config/schema.js";
import { loadAgent } from "../brain/agents.js";
import type { TurnEvent, TurnEventSink } from "../types.js";
import type { AgentDispatcher, DispatchArgs, DispatchResult } from "./base.js";
import { DISPATCH_RESULT_SENTINEL, DISPATCH_EVENT_SENTINEL } from "./base.js";
import { log } from "../log.js";

// Spawns one short-lived container per agent turn via the local docker socket.
//
// Container entrypoint: `/dae-runtime/agent-turn.sh` (injected runtime). The
// supervisor mounts a named docker volume populated with a Node binary and
// the daedalus install at /dae-runtime in every per-agent container, so user
// images don't need Node or daedalus baked in — just a glibc-compatible libc
// and a posix shell. See docs/docker-mode.md for the compatibility note.
//
// Set DAE_AGENT_RUNTIME_INJECT=false to fall back to the older "image must
// have `dae` on PATH" behaviour (useful for power users who've baked daedalus
// into their image and want to skip the runtime mount).
//
// Mounts every container gets (read from supervisor's config; paths in the
// supervisor process map onto host paths that the container then bind-mounts):
//   - brain          → /brain                (ro unless brain.writable)
//   - shared         → /shared               (rw — cross-agent scratch)
//   - sessions.db    → /data/sessions.sqlite (rw)
//   - attachments    → /data/attachments     (rw)
//   - docker.sock    → /var/run/docker.sock  (rw, ONLY for agents that spawn subagents)
//   - config dir     → /etc/daedalus         (ro — config + .env)
//   - dae-runtime    → /dae-runtime          (ro — injected node + daedalus)
//
// SSH: if the operator drops key material under <configDir>/ssh/ on the host,
// the agent-turn.sh shim symlinks it into $HOME/.ssh at startup (see
// runtime/setup-ssh.sh). Nothing dispatcher-side to do — it rides on the
// existing config dir mount.
//
// Per-agent containers join the daedalus docker network so MCPs / OneCLI /
// LiteLLM are reachable by container name (mempalace, onecli, …).
export interface ContainerDispatcherOptions {
  // Default image when an agent's manifest doesn't override container.image.
  // Set via DAE_AGENT_IMAGE_DEFAULT in compose. Required.
  defaultImage: string;
  // Docker network all spawned containers join. Set via DAE_AGENT_NETWORK.
  network: string;
  // Docker binary (defaults to "docker"; can override for testing).
  bin?: string;
  // Optional DOCKER_HOST socket override (-H ...).
  socket?: string;
  // The container path the supervisor's own /brain, /shared, /data are mounted
  // at — these become the host-side paths for the agent containers' bind mounts.
  // When running as the supervisor inside docker, the supervisor sees /brain;
  // it asks docker to bind-mount the named volume / host path that ends up
  // at /brain back into the agent container. We rely on supervisor env vars to
  // know the *host-side* paths because docker.sock bind mounts are evaluated by
  // the docker daemon on the host, not by the supervisor container.
  hostBrainPath: string;
  hostSharedPath: string;
  hostDataPath: string;
  hostConfigDir: string;
  // OneCLI bootstrap forwarded into the agent container so it can call
  // getContainerConfig itself at startup with the agent's own identifier.
  onecliApiKey?: string;
  // Named docker volume holding the injectable agent runtime (populated by the
  // dae-runtime-init compose service). When set, agent containers mount this
  // at /dae-runtime and the dispatcher overrides their entrypoint to use it.
  // When unset, the dispatcher assumes the agent image has `dae` on PATH
  // (the original behaviour).
  runtimeVolume?: string;
  // Extra env vars to forward into every agent container. Used for secrets that
  // local MCP servers need but that DON'T go through OneCLI (e.g. MEMPALACE_TOKEN
  // for the local mempalace memory server). MCP defs reference these via ${VAR};
  // expansion runs inside the container, so the var must be present there.
  forwardEnv?: Record<string, string>;
}

export class ContainerAgentDispatcher implements AgentDispatcher {
  readonly id = "container";
  // Honors DispatchArgs.onEvent: the container writes sentinel-framed TurnEvent lines on
  // stdout as its turn unfolds (DAE_EVENT_STREAM=ndjson), parsed + forwarded live below.
  readonly streaming = true;
  constructor(private config: ArtemisConfig, private opts: ContainerDispatcherOptions) {}

  async dispatch(args: DispatchArgs): Promise<DispatchResult> {
    // Per-agent image override comes from the manifest's container.image.
    const loaded = await loadAgent(this.config.brain.path, args.agentName).catch(() => null);
    const image = loaded?.manifest.container?.image ?? this.opts.defaultImage;

    // SEC-02: the host docker socket is root-equivalent, so only mount it for agents that
    // actually spawn subagents (they need the daemon to launch child containers). Leaf
    // agents — the ones running bash over untrusted web content — go without. Fail closed:
    // if the manifest didn't load, assume no spawn and withhold the socket.
    const mountDockerSock = (loaded?.manifest.subagents?.length ?? 0) > 0;
    // SEC-03: per-agent resource limits (manifest override → conservative global default).
    const limits = resolveContainerLimits(loaded?.manifest.container, this.config.runtime.limits);

    const containerName = `dae-${sanitize(args.agentName)}-${Date.now().toString(36)}`;
    // Stream the turn's events back only when the caller wants them (a live sink) and the
    // operator hasn't opted out — otherwise the container stays buffered-result-only.
    const streamEvents = Boolean(args.onEvent) && this.config.runtime.subagentEventStream;
    const dockerArgs = this.buildArgs({
      containerName,
      image,
      args,
      mountDockerSock,
      limits,
      streamEvents,
    });

    log.info(
      { agent: args.agentName, image, container: containerName },
      "dispatching agent turn in container",
    );

    const bin = this.opts.bin ?? "docker";
    // SEC-09: secrets are forwarded by NAME on the argv (-e KEY); supply their VALUES here in
    // the docker CLI's environment so they never appear in the world-readable process args.
    const forwardedSecrets: Record<string, string> = {
      ...(this.opts.onecliApiKey ? { ONECLI_API_KEY: this.opts.onecliApiKey } : {}),
      ...(this.opts.forwardEnv ?? {}),
    };
    const subprocess = execa(bin, dockerArgs, {
      timeout: args.timeoutMs ?? 5 * 60_000,
      reject: false,
      env: { ...process.env, ...forwardedSecrets },
      // The agent container reads nothing from stdin (it pulls all state from
      // the mounted session DB). Close stdin immediately so it doesn't block.
      input: "",
    });
    // Forward sentinel-framed event lines as they arrive. Reading stdout here doesn't
    // consume it away from execa's own buffering — both listen on the same stream — so the
    // final sentinel-framed DispatchResult parse below still sees the full output.
    if (streamEvents && args.onEvent && subprocess.stdout) {
      forwardEventLines(subprocess.stdout, args.onEvent);
    }
    const result = await subprocess;

    // BUG-17: remove the container on EVERY failure path (timeout / non-zero exit / unparseable
    // result), not only timeout. `--rm` covers a clean exit but not a wedged container; this
    // catch is belt-and-suspenders for the throw paths.
    try {
      if (result.timedOut) {
        throw new Error(`agent container '${containerName}' timed out`);
      }
      if (result.exitCode !== 0) {
        // The real failure is the LAST line of the container's output (the agent-turn
        // error), not the first — early lines are just OneCLI/bootstrap startup noise.
        // Show the TAIL, and log the larger tail at error level so `docker compose logs`
        // surfaces it without the supervisor truncating away the actual exception.
        const out = (result.stderr ?? "").trim() || (result.stdout ?? "").trim();
        log.error(
          { container: containerName, exitCode: result.exitCode, output: tailOf(out, 4000) },
          "agent container exited non-zero",
        );
        throw new Error(
          `agent container '${containerName}' exited ${result.exitCode}: ${tailOf(out, 600)}`,
        );
      }
      return parseDispatchResult(result.stdout ?? "");
    } catch (err) {
      await execa(bin, ["rm", "-f", containerName]).catch(() => undefined);
      throw err;
    }
  }

  private buildArgs(opts: {
    containerName: string;
    image: string;
    args: DispatchArgs;
    mountDockerSock: boolean;
    limits: ResolvedLimits;
    streamEvents: boolean;
  }): string[] {
    return buildContainerArgs({
      containerName: opts.containerName,
      image: opts.image,
      dispatchArgs: opts.args,
      opts: this.opts,
      brainWritable: this.config.brain.writable,
      mountDockerSock: opts.mountDockerSock,
      limits: opts.limits,
      streamEvents: opts.streamEvents,
    });
  }
}

// Attach a line reader to a spawning container's stdout and forward every sentinel-framed
// TurnEvent line to the sink. Garbled lines are skipped (events are display chrome, never
// control flow), and a throwing sink is contained so rendering bugs can't kill the dispatch.
export function forwardEventLines(stdout: NodeJS.ReadableStream, sink: TurnEventSink): void {
  const rl = readline.createInterface({ input: stdout });
  rl.on("line", (line) => {
    const ev = parseEventLine(line);
    if (!ev) return;
    try {
      sink(ev);
    } catch (err) {
      log.warn({ err: (err as Error).message }, "turn-event sink threw (ignored)");
    }
  });
  rl.on("error", () => undefined);
}

// Parse one stdout line into a TurnEvent, or null when it isn't a (valid) event line.
// Exported for tests.
export function parseEventLine(line: string): TurnEvent | null {
  const idx = line.indexOf(DISPATCH_EVENT_SENTINEL);
  if (idx === -1) return null;
  try {
    const parsed = JSON.parse(line.slice(idx + DISPATCH_EVENT_SENTINEL.length).trim()) as unknown;
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as TurnEvent;
    }
  } catch {
    /* not an event line — ignore */
  }
  return null;
}

// Pure, side-effect-free arg builder so tests can inspect what we'd hand to
// docker without ever spawning a process. The dispatcher class is a thin shell
// around this + execa.
export function buildContainerArgs(input: {
  containerName: string;
  image: string;
  dispatchArgs: DispatchArgs;
  opts: ContainerDispatcherOptions;
  brainWritable: boolean;
  // SEC-02: whether to bind-mount the host docker socket. Only true for agents that spawn
  // subagents; see the dispatch() call site for the rationale.
  mountDockerSock: boolean;
  // SEC-03: resolved per-agent resource limits (manifest override → conservative default).
  limits: ResolvedLimits;
  // Ask the container to stream its TurnEvents on stdout (DAE_EVENT_STREAM=ndjson).
  streamEvents?: boolean;
}): string[] {
  const { containerName, image, dispatchArgs, opts, brainWritable, mountDockerSock, limits } = input;
  const a: string[] = [];
  if (opts.socket) a.push("-H", opts.socket);
  a.push("run", "--rm", "-i", "--name", containerName);
  a.push("--network", opts.network);

  // SEC-03: hardening + resource limits on every agent container. cap-drop=ALL +
  // no-new-privileges close residual escalation paths (the container is non-root uid 1000);
  // memory/cpu/pids are conservative by default (runtime.limits) unless the manifest raises them.
  a.push("--cap-drop", "ALL");
  a.push("--security-opt", "no-new-privileges");
  a.push("--pids-limit", String(limits.pidsLimit));
  a.push("--memory", limits.memory);
  a.push("--cpus", limits.cpus);

  // Mounts — host paths come from supervisor env; container-side paths are the
  // conventional /brain, /shared, /data, /etc/daedalus.
  const ro = brainWritable ? "rw" : "ro";
  a.push("-v", `${opts.hostBrainPath}:/brain:${ro}`);
  a.push("-v", `${opts.hostSharedPath}:/shared:rw`);
  a.push("-v", `${opts.hostDataPath}:/data:rw`);
  a.push("-v", `${opts.hostConfigDir}:/etc/daedalus:ro`);
  // SEC-02: root-equivalent — mounted ONLY for spawning agents. A spawning agent still has
  // full host access via the raw socket; the broker follow-up (AUDIT.md SEC-02) closes that.
  // This only shrinks the blast radius to agents that genuinely need to launch children.
  if (mountDockerSock) {
    a.push("-v", "/var/run/docker.sock:/var/run/docker.sock");
  }

  // Injectable runtime — the Node binary + daedalus install the agent will
  // actually execute. With this, the user's image needs only a posix shell
  // and glibc-compatible libc; Node/daedalus need not be installed.
  if (opts.runtimeVolume) {
    a.push("-v", `${opts.runtimeVolume}:/dae-runtime:ro`);
  }

  // Env. The agent inside the container resolves its own OneCLI bundle so it
  // gets a per-agent identity for credential scoping — we just forward the
  // daemon API key. ONECLI agent identifier is derived from the daedalus agent
  // name inside agent-turn (see applyOneCli call site).
  a.push("-e", "DAE_CONFIG=/etc/daedalus/config.yaml");
  a.push("-e", "DAE_DISPATCHER=container"); // nested subagent spawns recurse
  // Live event streaming: the agent-turn entrypoint writes sentinel-framed TurnEvent lines
  // on stdout, which dispatch() parses + forwards. Only set when the caller has a live sink.
  if (input.streamEvents) a.push("-e", "DAE_EVENT_STREAM=ndjson");
  a.push("-e", `DAE_AGENT_IMAGE_DEFAULT=${opts.defaultImage}`);
  a.push("-e", `DAE_AGENT_NETWORK=${opts.network}`);
  a.push("-e", `DAE_AGENT_HOST_BRAIN=${opts.hostBrainPath}`);
  a.push("-e", `DAE_AGENT_HOST_SHARED=${opts.hostSharedPath}`);
  a.push("-e", `DAE_AGENT_HOST_DATA=${opts.hostDataPath}`);
  a.push("-e", `DAE_AGENT_HOST_CONFIG=${opts.hostConfigDir}`);
  if (opts.runtimeVolume) {
    a.push("-e", `DAE_AGENT_RUNTIME_VOLUME=${opts.runtimeVolume}`);
  }
  if (opts.onecliApiKey) {
    // SEC-09: forward by NAME so the secret value isn't on the world-readable docker argv
    // (/proc/<pid>/cmdline). docker pulls the value from the CLI's own env, which the
    // dispatcher sets explicitly — the value lives in /proc/<pid>/environ (owner-only) instead.
    a.push("-e", "ONECLI_API_KEY");
  }
  // Override the OneCLI agent identifier with THIS specific agent's name so
  // OneCLI scopes injection to whatever credentials this agent has been
  // granted — not what the supervisor agent has been granted.
  a.push("-e", `DAE_ONECLI_AGENT=${dispatchArgs.agentName}`);

  // Local-service secrets (e.g. MEMPALACE_TOKEN) that aren't injected via OneCLI,
  // so MCP defs using ${VAR} expansion resolve inside the container. SEC-09: forwarded by
  // name (value supplied via the dispatcher's env), so it never lands in the argv.
  for (const k of Object.keys(opts.forwardEnv ?? {})) {
    a.push("-e", k);
  }

  // Entrypoint override. With the injected runtime, we ignore the image's
  // own ENTRYPOINT and run daedalus through the mounted shim — agents work
  // regardless of what the image was designed to do at startup. Without the
  // runtime mount, fall back to `dae` on PATH (requires daedalus in image).
  if (opts.runtimeVolume) {
    a.push("--entrypoint", "/dae-runtime/agent-turn.sh");
  }

  a.push(image);
  // With the runtime mount, the entrypoint shim is `dae`'s equivalent and
  // we pass `agent-turn …` directly. Without it, we need `dae` on PATH.
  if (!opts.runtimeVolume) a.push("dae");
  a.push(
    "agent-turn",
    "--agent",
    dispatchArgs.agentName,
    "--session",
    dispatchArgs.sessionId,
    "--user",
    dispatchArgs.userId,
    ...(dispatchArgs.isSubagent ? ["--subagent"] : []),
    ...(dispatchArgs.originChannel
      ? ["--origin-channel", dispatchArgs.originChannel]
      : []),
    ...(dispatchArgs.originExternalUserId
      ? ["--origin-external-user", dispatchArgs.originExternalUserId]
      : []),
  );
  return a;
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Like truncate, but keeps the END of the string — the part with the actual error.
function tailOf(s: string, n: number): string {
  return s.length > n ? "…" + s.slice(-n) : s;
}

// BUG-01: the agent-turn entrypoint frames its DispatchResult with DISPATCH_RESULT_SENTINEL.
// Scan bottom-up for the sentinel-framed line and parse only that — arbitrary JSON or startup
// noise on stdout (or a process writing to the container's fd 1) can no longer be mistaken for,
// or forge, the turn result. Exported for tests.
export function parseDispatchResult(stdout: string): DispatchResult {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const idx = lines[i]!.indexOf(DISPATCH_RESULT_SENTINEL);
    if (idx === -1) continue;
    const json = lines[i]!.slice(idx + DISPATCH_RESULT_SENTINEL.length).trim();
    try {
      const parsed = JSON.parse(json) as DispatchResult;
      if (parsed.status === "complete" || parsed.status === "pending_question") {
        return parsed;
      }
    } catch {
      // sentinel present but payload not parseable — keep scanning (defensive).
    }
  }
  throw new Error(
    `agent container produced no sentinel-framed DispatchResult. Last 500 bytes: ${truncate(stdout, 500)}`,
  );
}

// Build a ContainerDispatcherOptions from the current process env. Used by the
// supervisor and any agent container that wants to spawn subagents.
export function dispatcherOptionsFromEnv(config: ArtemisConfig): ContainerDispatcherOptions {
  const env = process.env;
  const defaultImage = env.DAE_AGENT_IMAGE_DEFAULT;
  if (!defaultImage) {
    throw new Error(
      "DAE_AGENT_IMAGE_DEFAULT is required for the container dispatcher. " +
        "Set it on the supervisor (docker-compose: services.daedalus.environment.DAE_AGENT_IMAGE_DEFAULT).",
    );
  }
  const opts: ContainerDispatcherOptions = {
    defaultImage,
    network: env.DAE_AGENT_NETWORK ?? "daedalus",
    hostBrainPath: env.DAE_AGENT_HOST_BRAIN ?? path.resolve(config.brain.path),
    hostSharedPath: env.DAE_AGENT_HOST_SHARED ?? path.resolve(config.runtime.shared.hostPath),
    hostDataPath: env.DAE_AGENT_HOST_DATA ?? path.resolve(path.dirname(config.sessions.dbPath)),
    hostConfigDir: env.DAE_AGENT_HOST_CONFIG ?? path.resolve(path.dirname(env.DAE_CONFIG ?? "/etc/daedalus/config.yaml")),
  };
  if (env.ONECLI_API_KEY) opts.onecliApiKey = env.ONECLI_API_KEY;
  if (env.DOCKER_HOST) opts.socket = env.DOCKER_HOST;
  // Forward local-service secrets that bypass OneCLI (so MCP defs using ${VAR}
  // resolve inside the container). MEMPALACE_TOKEN is the memory server's bearer.
  const forwardEnv: Record<string, string> = {};
  if (env.MEMPALACE_TOKEN) forwardEnv.MEMPALACE_TOKEN = env.MEMPALACE_TOKEN;
  // Keep spawned agents on the supervisor's timezone so their "# Now" local time matches
  // the scheduler. Without it the agent container falls back to UTC.
  if (env.TZ) forwardEnv.TZ = env.TZ;
  if (Object.keys(forwardEnv).length > 0) opts.forwardEnv = forwardEnv;
  // Inject the runtime by default if a volume is named. Opt out with
  // DAE_AGENT_RUNTIME_INJECT=false (useful when the agent image already has
  // daedalus baked in and the operator wants to skip the mount).
  const injectOptOut = (env.DAE_AGENT_RUNTIME_INJECT ?? "true").toLowerCase() === "false";
  if (!injectOptOut && env.DAE_AGENT_RUNTIME_VOLUME) {
    opts.runtimeVolume = env.DAE_AGENT_RUNTIME_VOLUME;
  }
  return opts;
}
