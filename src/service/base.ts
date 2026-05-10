// Cross-platform "long-running service" abstraction. Linux → systemd user units, macOS →
// launchd user agents, Windows → friendly-error stub (use WSL).
//
// All managers operate on a `ServiceSpec` (name, command, working dir, env, restart policy)
// and write a unit file scoped to the current user — no sudo required for the common path.
// Booting after logout requires platform-specific extras: `loginctl enable-linger $USER` on
// systemd, or moving the unit to /Library/LaunchDaemons on macOS — both flagged in the
// install summary, never run automatically.

export interface ServiceSpec {
  // Logical name. Becomes the systemd unit name and the launchd label suffix.
  name: string;
  description: string;
  // Absolute path to the executable. argv-style.
  exec: string;
  args: string[];
  env?: Record<string, string>;
  workingDir?: string;
  restart?: "no" | "on-failure" | "always";
  restartDelaySec?: number;
  // Where to write log files (launchd only — systemd uses journald).
  logsDir?: string;
}

export interface ServiceStatus {
  active: boolean;
  exists: boolean;
  detail: string; // human-readable status output (raw from systemctl/launchctl)
}

export interface InstallResult {
  unitPath: string;
  notes: string[]; // post-install reminders (e.g. enable-linger)
}

export interface ServiceManager {
  readonly id: "systemd" | "launchd" | "unsupported";
  readonly platformLabel: string;

  install(spec: ServiceSpec, opts?: { dryRun?: boolean }): Promise<InstallResult & { unitContent: string }>;
  uninstall(name: string): Promise<void>;
  start(name: string): Promise<void>;
  stop(name: string): Promise<void>;
  restart(name: string): Promise<void>;
  status(name: string): Promise<ServiceStatus>;
  // Returns the command the user can run for streaming logs (we don't tail in-process —
  // platform tools do this better).
  logsCommand(name: string): string;
}

export class ServiceUnsupported extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceUnsupported";
  }
}
