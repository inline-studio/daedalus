import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { InstallResult, ServiceManager, ServiceSpec, ServiceStatus } from "./base.js";

// macOS launchd manager. Writes user agents to ~/Library/LaunchAgents/com.daedalus.<name>.plist.
// Loads with `launchctl load -w` (the -w flag flips the Disabled key to false too).
//
// User agents run when the user logs in. To survive logout we'd write a LaunchDaemon to
// /Library/LaunchDaemons/ — that needs sudo and a different scope; flagged in install notes.
export class LaunchdManager implements ServiceManager {
  readonly id = "launchd" as const;
  readonly platformLabel = "macOS (launchd, user agent)";

  private label(name: string): string {
    return `com.daedalus.${name}`;
  }
  private plistPath(name: string): string {
    return path.join(os.homedir(), "Library", "LaunchAgents", `${this.label(name)}.plist`);
  }

  async install(spec: ServiceSpec, opts: { dryRun?: boolean } = {}): Promise<InstallResult & { unitContent: string }> {
    const logsDir = spec.logsDir ?? path.join(os.homedir(), ".daedalus", "logs");
    const content = renderPlist(this.label(spec.name), spec, logsDir);
    const unitPath = this.plistPath(spec.name);
    const notes: string[] = [];

    if (opts.dryRun) {
      return { unitPath, unitContent: content, notes: [`(dry-run) would write ${unitPath}`] };
    }

    await fs.mkdir(path.dirname(unitPath), { recursive: true });
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(unitPath, content, "utf8");

    // -w persists the change; safe to call multiple times.
    await execa("launchctl", ["load", "-w", unitPath], { reject: false });

    notes.push(
      `Installed at ${unitPath}`,
      `Service started. Useful commands:`,
      `  launchctl list | grep ${this.label(spec.name)}`,
      `  ${this.logsCommand(spec.name)}`,
      ``,
      `User agents stop when you log out. To run on boot regardless of login, move the`,
      `plist into /Library/LaunchDaemons/ (needs sudo) and reload as root.`,
    );
    return { unitPath, unitContent: content, notes };
  }

  async uninstall(name: string): Promise<void> {
    const unitPath = this.plistPath(name);
    await execa("launchctl", ["unload", "-w", unitPath], { reject: false });
    try {
      await fs.rm(unitPath);
    } catch {
      /* already gone */
    }
  }

  async start(name: string): Promise<void> {
    await execa("launchctl", ["start", this.label(name)]);
  }
  async stop(name: string): Promise<void> {
    await execa("launchctl", ["stop", this.label(name)]);
  }
  async restart(name: string): Promise<void> {
    await this.stop(name);
    await this.start(name);
  }

  async status(name: string): Promise<ServiceStatus> {
    const list = await execa("launchctl", ["list"], { reject: false });
    const labelLine = (list.stdout ?? "")
      .split("\n")
      .find((l) => l.includes(this.label(name)));
    return {
      active: Boolean(labelLine && !/^-/.test(labelLine)),
      exists: Boolean(labelLine),
      detail: labelLine ?? `(not loaded)`,
    };
  }

  logsCommand(name: string): string {
    const out = path.join(os.homedir(), ".daedalus", "logs", `${name}.out.log`);
    return `tail -f ${out}`;
  }
}

function renderPlist(label: string, spec: ServiceSpec, logsDir: string): string {
  const argv = [spec.exec, ...spec.args];
  const envEntries = Object.entries(spec.env ?? {});
  const env =
    envEntries.length === 0
      ? ""
      : `  <key>EnvironmentVariables</key>\n  <dict>\n` +
        envEntries.map(([k, v]) => `    <key>${k}</key><string>${xml(v)}</string>`).join("\n") +
        `\n  </dict>\n`;
  const wd = spec.workingDir
    ? `  <key>WorkingDirectory</key><string>${xml(spec.workingDir)}</string>\n`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    <string>${xml(a)}</string>`).join("\n")}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>${spec.restart === "no" ? "<false/>" : "<true/>"}
${wd}${env}  <key>StandardOutPath</key><string>${xml(path.join(logsDir, `${spec.name}.out.log`))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsDir, `${spec.name}.err.log`))}</string>
</dict>
</plist>
`;
}

function xml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
