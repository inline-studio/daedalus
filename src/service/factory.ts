import fs from "node:fs";
import { execa } from "execa";
import type { ServiceManager } from "./base.js";
import { ServiceUnsupported } from "./base.js";
import { SystemdManager } from "./systemd.js";
import { LaunchdManager } from "./launchd.js";

// Pick the right manager for the host OS.
// Linux  → systemd (verifies systemctl is present and the user bus is reachable)
// macOS  → launchd (always present)
// WSL2   → typically systemd; same path as Linux.
// Windows → friendly error pointing at WSL.
export async function buildServiceManager(): Promise<ServiceManager> {
  const platform = process.platform;
  if (platform === "darwin") return new LaunchdManager();
  if (platform === "linux") {
    // Confirm systemctl is on PATH and the user bus is up; bail with a clear message otherwise.
    try {
      await execa("systemctl", ["--user", "--version"], { timeout: 5_000 });
    } catch {
      throw new ServiceUnsupported(
        "systemctl --user isn't available. This box doesn't have systemd user instances enabled.\n" +
          "If you're on WSL: ensure /etc/wsl.conf has [boot] systemd=true and `wsl --shutdown` once.\n" +
          "If you're on a non-systemd distro (Alpine, Void, …), use your service manager directly.",
      );
    }
    return new SystemdManager();
  }
  if (platform === "win32") {
    throw new ServiceUnsupported(
      "`dae service ...` isn't supported on Windows. Run via WSL2 (where systemd works),\n" +
        "or invoke `dae serve` from a process manager you already use (NSSM, Task Scheduler, etc.).",
    );
  }
  throw new ServiceUnsupported(`unsupported platform: ${platform}`);
}

// Detect WSL for friendlier messaging.
export function isWsl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const release = fs.readFileSync("/proc/sys/kernel/osrelease", "utf8");
    return /microsoft/i.test(release);
  } catch {
    return false;
  }
}
