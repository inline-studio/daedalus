import { execa } from "execa";
import path from "node:path";
import type { ArtemisConfig } from "../config/schema.js";
import { loadAgent } from "../brain/agents.js";
import type { AgentDispatcher, DispatchArgs, DispatchResult } from "./base.js";
import { log } from "../log.js";

// Spawns one short-lived container per agent turn via the local docker socket.
//
// Container entrypoint: `dae agent-turn` (see src/index.ts). The turn reads
// session state from the mounted sqlite, runs the kernel, persists the response,
// and prints a JSON DispatchResult to stdout before exiting.
//
// Mounts every container gets (read from supervisor's config; paths in the
// supervisor process map onto host paths that the container then bind-mounts):
//   - brain        → /brain                (ro unless brain.writable)
//   - shared       → /shared               (rw — cross-agent scratch)
//   - sessions.db  → /data/sessions.sqlite (rw)
//   - attachments  → /data/attachments     (rw)
//   - docker.sock  → /var/run/docker.sock  (rw, so nested subagent spawns work)
//   - config dir   → /etc/daedalus         (ro — config + .env)
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
}

export class ContainerAgentDispatcher implements AgentDispatcher {
  readonly id = "container";
  constructor(private config: ArtemisConfig, private opts: ContainerDispatcherOptions) {}

  async dispatch(args: DispatchArgs): Promise<DispatchResult> {
    // Per-agent image override comes from the manifest's container.image.
    const loaded = await loadAgent(this.config.brain.path, args.agentName).catch(() => null);
    const image = loaded?.manifest.container?.image ?? this.opts.defaultImage;

    const containerName = `dae-${sanitize(args.agentName)}-${Date.now().toString(36)}`;
    const dockerArgs = this.buildArgs({ containerName, image, args });

    log.info(
      { agent: args.agentName, image, container: containerName },
      "dispatching agent turn in container",
    );

    const bin = this.opts.bin ?? "docker";
    const result = await execa(bin, dockerArgs, {
      timeout: args.timeoutMs ?? 5 * 60_000,
      reject: false,
      // The agent container reads nothing from stdin (it pulls all state from
      // the mounted session DB). Close stdin immediately so it doesn't block.
      input: "",
    });

    if (result.timedOut) {
      // Best-effort kill; the container may already be gone.
      await execa(bin, ["rm", "-f", containerName]).catch(() => undefined);
      throw new Error(`agent container '${containerName}' timed out`);
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `agent container '${containerName}' exited ${result.exitCode}: ${truncate(result.stderr ?? "", 500)}`,
      );
    }

    return parseDispatchResult(result.stdout ?? "");
  }

  private buildArgs(opts: {
    containerName: string;
    image: string;
    args: DispatchArgs;
  }): string[] {
    const a: string[] = [];
    if (this.opts.socket) a.push("-H", this.opts.socket);
    a.push("run", "--rm", "-i", "--name", opts.containerName);
    a.push("--network", this.opts.network);

    // Mounts — host paths come from supervisor env; container-side paths are the
    // conventional /brain, /shared, /data, /etc/daedalus.
    const ro = this.config.brain.writable ? "rw" : "ro";
    a.push("-v", `${this.opts.hostBrainPath}:/brain:${ro}`);
    a.push("-v", `${this.opts.hostSharedPath}:/shared:rw`);
    a.push("-v", `${this.opts.hostDataPath}:/data:rw`);
    a.push("-v", `${this.opts.hostConfigDir}:/etc/daedalus:ro`);
    a.push("-v", "/var/run/docker.sock:/var/run/docker.sock");

    // Per-agent extra binds from the manifest.
    if (opts.args.agentName && this.config.brain.path) {
      // (Agent manifest binds are handled by buildRuntime inside the container.)
    }

    // Env. The agent inside the container resolves its own OneCLI bundle so it
    // gets a per-agent identity for credential scoping — we just forward the
    // daemon API key. ONECLI agent identifier is derived from the daedalus agent
    // name inside agent-turn (see applyOneCli call site).
    a.push("-e", "DAE_CONFIG=/etc/daedalus/config.yaml");
    a.push("-e", "DAE_DISPATCHER=container"); // nested subagent spawns recurse
    a.push("-e", `DAE_AGENT_IMAGE_DEFAULT=${this.opts.defaultImage}`);
    a.push("-e", `DAE_AGENT_NETWORK=${this.opts.network}`);
    a.push("-e", `DAE_AGENT_HOST_BRAIN=${this.opts.hostBrainPath}`);
    a.push("-e", `DAE_AGENT_HOST_SHARED=${this.opts.hostSharedPath}`);
    a.push("-e", `DAE_AGENT_HOST_DATA=${this.opts.hostDataPath}`);
    a.push("-e", `DAE_AGENT_HOST_CONFIG=${this.opts.hostConfigDir}`);
    if (this.opts.onecliApiKey) {
      a.push("-e", `ONECLI_API_KEY=${this.opts.onecliApiKey}`);
    }
    // Override the OneCLI agent identifier with THIS specific agent's name so
    // OneCLI scopes injection to whatever credentials this agent has been
    // granted — not what the supervisor agent has been granted.
    a.push("-e", `DAE_ONECLI_AGENT=${opts.args.agentName}`);

    a.push(opts.image);
    // The container's CMD defaults to `dae serve`; override with agent-turn args.
    a.push(
      "dae",
      "agent-turn",
      "--agent",
      opts.args.agentName,
      "--session",
      opts.args.sessionId,
      "--user",
      opts.args.userId,
      ...(opts.args.isSubagent ? ["--subagent"] : []),
    );
    return a;
  }
}

function sanitize(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 40);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// The agent container is expected to print a single JSON DispatchResult on the
// last non-empty line of stdout. We tolerate prior log lines (e.g. OneCLI proxy
// info) by scanning bottom-up for the first parseable JSON object.
function parseDispatchResult(stdout: string): DispatchResult {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as DispatchResult;
      if (parsed.status === "complete" || parsed.status === "pending_question") {
        return parsed;
      }
    } catch {
      // not JSON; keep scanning
    }
  }
  throw new Error(
    `agent container produced no parseable DispatchResult. Last 500 bytes: ${truncate(stdout, 500)}`,
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
  return opts;
}
