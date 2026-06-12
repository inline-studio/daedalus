import { execa } from "execa";
import type { ExecOptions, ExecResult, Runtime } from "./base.js";

export interface DockerRuntimeOptions {
  image: string; // default image when ExecOptions.image is unset
  defaultNetwork?: string;
  binds?: Array<{ host: string; container: string; readOnly?: boolean }>; // applied to every exec
  workdir?: string;
  // Path to the docker binary. If unset, falls back to env DOCKER_BIN, then "docker" on PATH.
  bin?: string;
  socket?: string; // optional DOCKER_HOST override (-H ...)
  // SEC-03: resource limits applied to every exec (resolved per-agent → global default).
  memory?: string;
  cpus?: string;
  pidsLimit?: number;
}

// Runs each command in `docker run --rm` against the agent's declared image.
// The container is ephemeral per-call; long-running state should live in bind mounts.
export class DockerRuntime implements Runtime {
  readonly id = "docker" as const;

  constructor(private opts: DockerRuntimeOptions) {}

  private get bin(): string {
    return this.opts.bin ?? process.env.DOCKER_BIN ?? "docker";
  }

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const image = opts.image ?? this.opts.image;
    const args: string[] = [];
    if (this.opts.socket) args.push("-H", this.opts.socket);
    args.push("run", "--rm", "-i");

    const binds = [...(this.opts.binds ?? []), ...(opts.binds ?? [])];
    for (const b of binds) {
      const ro = b.readOnly ? ":ro" : "";
      args.push("-v", `${b.host}:${b.container}${ro}`);
    }

    if (opts.cwd ?? this.opts.workdir) {
      args.push("-w", opts.cwd ?? this.opts.workdir!);
    }
    for (const [k, v] of Object.entries(opts.env ?? {})) {
      args.push("-e", `${k}=${v}`);
    }
    if (opts.network ?? this.opts.defaultNetwork) {
      args.push("--network", opts.network ?? this.opts.defaultNetwork!);
    }
    // SEC-03: hardening + resource limits on every docker-runtime exec (non-root uid 1000).
    args.push("--cap-drop", "ALL", "--security-opt", "no-new-privileges");
    const memory = opts.memory ?? this.opts.memory;
    const cpus = opts.cpus ?? this.opts.cpus;
    if (memory) args.push("--memory", memory);
    if (cpus) args.push("--cpus", cpus);
    if (this.opts.pidsLimit) args.push("--pids-limit", String(this.opts.pidsLimit));
    // On Linux, host.docker.internal isn't mapped automatically (unlike macOS/Windows Docker
    // Desktop). Add the mapping so containers can reach host services via that hostname.
    if (process.platform === "linux") {
      args.push("--add-host", "host.docker.internal:host-gateway");
    }

    args.push(image, "/bin/sh", "-c", cmd);

    try {
      const result = await execa(this.bin, args, {
        timeout: opts.timeoutMs ?? 120_000,
        reject: false,
      });
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 1,
        timedOut: result.timedOut ?? false,
      };
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
        exitCode: 1,
        timedOut: false,
      };
    }
  }
}
