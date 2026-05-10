import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { InstallResult, ServiceManager, ServiceSpec, ServiceStatus } from "./base.js";

// systemd user-unit manager. Writes to ~/.config/systemd/user/<name>.service.
// Doesn't require sudo. After install, the unit auto-runs at login; for boot-time
// startup the user must run `sudo loginctl enable-linger $USER` once — we don't try.
export class SystemdManager implements ServiceManager {
  readonly id = "systemd" as const;
  readonly platformLabel = "Linux (systemd, user mode)";

  private get unitDir(): string {
    return path.join(os.homedir(), ".config", "systemd", "user");
  }

  private unitPath(name: string): string {
    return path.join(this.unitDir, `${name}.service`);
  }

  async install(spec: ServiceSpec, opts: { dryRun?: boolean } = {}): Promise<InstallResult & { unitContent: string }> {
    const content = renderUnit(spec);
    const unitPath = this.unitPath(spec.name);

    const postInstallNotes = [
      `Installed at ${unitPath}`,
      `Service started. Useful commands:`,
      `  systemctl --user status ${spec.name}`,
      `  systemctl --user restart ${spec.name}`,
      `  ${this.logsCommand(spec.name)}`,
      ``,
      `User services stop on logout. To survive logout / start at boot, run once:`,
      `  sudo loginctl enable-linger $USER`,
    ];

    if (opts.dryRun) {
      return {
        unitPath,
        unitContent: content,
        notes: [
          `(dry-run) would write ${unitPath} and run: daemon-reload → enable → start`,
          ``,
          ...postInstallNotes,
        ],
      };
    }

    await fs.mkdir(this.unitDir, { recursive: true });
    await fs.writeFile(unitPath, content, "utf8");

    await execa("systemctl", ["--user", "daemon-reload"]);
    await execa("systemctl", ["--user", "enable", spec.name]);
    await execa("systemctl", ["--user", "start", spec.name]);

    return { unitPath, unitContent: content, notes: postInstallNotes };
  }

  async uninstall(name: string): Promise<void> {
    const unitPath = this.unitPath(name);
    // Ignore "not loaded" errors — uninstall is idempotent.
    await execa("systemctl", ["--user", "stop", name], { reject: false });
    await execa("systemctl", ["--user", "disable", name], { reject: false });
    try {
      await fs.rm(unitPath);
    } catch {
      /* already gone */
    }
    await execa("systemctl", ["--user", "daemon-reload"], { reject: false });
  }

  async start(name: string): Promise<void> {
    await execa("systemctl", ["--user", "start", name]);
  }
  async stop(name: string): Promise<void> {
    await execa("systemctl", ["--user", "stop", name]);
  }
  async restart(name: string): Promise<void> {
    await execa("systemctl", ["--user", "restart", name]);
  }

  async status(name: string): Promise<ServiceStatus> {
    const isActive = await execa("systemctl", ["--user", "is-active", name], { reject: false });
    const detail = await execa("systemctl", ["--user", "status", name, "--no-pager"], { reject: false });
    return {
      active: (isActive.stdout ?? "").trim() === "active",
      exists: detail.exitCode !== 4, // 4 = no such service
      detail: (detail.stdout ?? "") + (detail.stderr ? `\n${detail.stderr}` : ""),
    };
  }

  logsCommand(name: string): string {
    return `journalctl --user -u ${name} -f`;
  }
}

function renderUnit(spec: ServiceSpec): string {
  // Quote arguments that contain spaces; systemd's ExecStart parses with shell-like rules.
  const argv = [shellQuote(spec.exec), ...spec.args.map(shellQuote)].join(" ");
  const envLines = Object.entries(spec.env ?? {}).map(
    ([k, v]) => `Environment=${k}=${shellQuote(v)}`,
  );
  const lines = [
    `[Unit]`,
    `Description=${spec.description}`,
    `After=network-online.target`,
    `Wants=network-online.target`,
    ``,
    `[Service]`,
    `Type=simple`,
    `ExecStart=${argv}`,
    spec.workingDir ? `WorkingDirectory=${spec.workingDir}` : "",
    `Restart=${spec.restart ?? "on-failure"}`,
    `RestartSec=${spec.restartDelaySec ?? 5}`,
    ...envLines,
    `StandardOutput=journal`,
    `StandardError=journal`,
    ``,
    `[Install]`,
    `WantedBy=default.target`,
    ``,
  ];
  return lines.filter((l) => l !== "" || true).join("\n").replace(/\n\n+/g, "\n\n");
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
