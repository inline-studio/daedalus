// Execution runtime abstraction. The kernel calls this for shell-style tool execution.
// Three implementations: HostRuntime (run in the current process's environment),
// DockerRuntime (run in a per-agent container), and RemoteRuntime (run on the user's
// machine via the `dae remote` executor bridge).

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
  readonly id: "host" | "docker" | "remote";
  exec(cmd: string, opts: ExecOptions): Promise<ExecResult>;
  // Optional file-op routing. When a runtime implements these, the read/write/edit tools
  // go through it instead of the local fs — so a remote-executing turn reads and writes
  // the USER'S files, coherently with where its bash runs. Runtimes without them (host,
  // docker) keep the direct-fs behaviour.
  readFile?(path: string): Promise<string>;
  writeFile?(path: string, content: string): Promise<void>;
}
