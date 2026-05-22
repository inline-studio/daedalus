import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { InstallResult, ServiceManager, ServiceSpec, ServiceStatus } from "./base.js";
import { ensureLinger } from "./linger.js";

// systemd user-unit manager. Writes to ~/.config/systemd/user/<name>.service.
// Doesn't require sudo for the unit itself. After install, the unit auto-runs at
// login; for boot-time startup / survival across logout we run `sudo loginctl
// enable-linger $USER` interactively (with the user's consent) — see linger.ts.
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
    const unitPath = this.unitPath(spec.name);

    const postInstallNotes = [
      `Installed at ${unitPath}`,
      `Service started. Useful commands:`,
      `  systemctl --user status ${spec.name}`,
      `  systemctl --user restart ${spec.name}`,
      `  ${this.logsCommand(spec.name)}`,
    ];

    if (opts.dryRun) {
      // Preview only — render with the command as configured (don't require it to
      // be installed on the previewing machine).
      return {
        unitPath,
        unitContent: renderUnit(spec),
        notes: [
          `(dry-run) would write ${unitPath} and run: daemon-reload → enable → start`,
          `(dry-run) would also offer to: sudo loginctl enable-linger $USER (if currently disabled)`,
          ``,
          ...postInstallNotes,
        ],
      };
    }

    // Real install: resolve the exec to an absolute path. systemd user units don't
    // inherit your shell PATH, so a bare command in ExecStart fails at launch with
    // status=203/EXEC — resolving now fails fast with a clear message instead.
    const exec = await resolveExecAbsolute(spec.exec);
    const content = renderUnit(exec === spec.exec ? spec : { ...spec, exec });

    await fs.mkdir(this.unitDir, { recursive: true });
    await fs.writeFile(unitPath, content, "utf8");

    await execa("systemctl", ["--user", "daemon-reload"]);
    await execa("systemctl", ["--user", "enable", spec.name]);
    await execa("systemctl", ["--user", "start", spec.name]);

    // Offer to enable linger so the service survives logout + starts at boot.
    // Cached after the first call, so a multi-service install (`--all`) only
    // prompts once. Non-fatal on every failure path.
    try {
      const linger = await ensureLinger({});
      postInstallNotes.push(...linger.notes);
    } catch (err) {
      postInstallNotes.push(
        `(could not check linger: ${(err as Error).message})`,
        `Run this if services stop when you log out:`,
        `  sudo loginctl enable-linger $USER`,
      );
    }

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

async function resolveExecAbsolute(exec: string): Promise<string> {
  if (path.isAbsolute(exec)) return exec;
  // Resolve a bare command name via the installer's PATH — systemd user units
  // have no inherited PATH, so a bare name in ExecStart fails with 203/EXEC.
  const r = await execa("which", [exec], { reject: false });
  const abs = (r.stdout ?? "").trim().split("\n")[0]?.trim();
  if (r.exitCode === 0 && abs) return abs;
  throw new Error(
    `Service command '${exec}' isn't an absolute path and wasn't found on PATH. ` +
      `systemd user units can't exec a bare command (status=203/EXEC) — set an ` +
      `absolute path for the command (e.g. the output of \`which ${exec}\`).`,
  );
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
    // Fail loudly instead of crash-looping forever: if it dies more than 5 times
    // in 60s, systemd stops trying and marks the unit failed (`systemctl --user
    // status <name>` shows it). A misconfigured ExecStart should surface fast,
    // not spin tens of thousands of restarts.
    `StartLimitIntervalSec=60`,
    `StartLimitBurst=5`,
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
