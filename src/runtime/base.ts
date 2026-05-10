// Execution runtime abstraction. The kernel calls this for shell-style tool execution.
// Two implementations: HostRuntime (run on host) and DockerRuntime (run in a per-agent container).

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  // Bind mounts: host path -> container path. Read-only by default.
  binds?: Array<{ host: string; container: string; readOnly?: boolean }>;
  // For container runtime: image override
  image?: string;
  // Resource limits
  memory?: string; // e.g. "512m"
  cpus?: string; // e.g. "0.5"
  network?: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export interface Runtime {
  readonly id: "host" | "docker";
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;
}
