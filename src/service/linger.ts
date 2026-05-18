import { execa } from "execa";
import os from "node:os";
import prompts from "prompts";

// systemd "linger" governs whether a user's --user services survive logout and
// start at boot. Off by default. Without it, every `dae service install` puts a
// unit in place that silently stops the moment the install shell exits — which
// is almost certainly not what the user wants for a long-running supervisor.
//
// This module detects linger state and offers to enable it during the install
// flow. We try `sudo -n` first (no-prompt) for users with NOPASSWD configured;
// fall back to an interactive sudo (TTY password prompt) on consent; print the
// manual command as a last resort.

// Cache so a multi-service install (e.g. `dae service install --all`) doesn't
// re-prompt for each unit.
let cachedStatus: LingerStatus | null = null;

export type LingerStatus = "enabled" | "disabled" | "unknown";

export interface EnsureLingerOptions {
  // Whether interactive prompts are allowed. Defaults to true. CI / scripted
  // installs should pass false.
  interactive?: boolean;
  // Used in messages; defaults to $USER.
  user?: string;
}

export interface EnsureLingerResult {
  // Final state (best effort — "unknown" if we couldn't check).
  status: LingerStatus;
  // What we actually did, for the install notes.
  action: "already-enabled" | "enabled" | "declined" | "failed" | "non-linux" | "skipped";
  // Hint lines to surface to the user.
  notes: string[];
}

export async function ensureLinger(opts: EnsureLingerOptions = {}): Promise<EnsureLingerResult> {
  if (os.platform() !== "linux") {
    return { status: "unknown", action: "non-linux", notes: [] };
  }
  const user = opts.user ?? process.env.USER ?? "";
  if (!user) {
    return {
      status: "unknown",
      action: "skipped",
      notes: ["could not determine $USER — skipped linger check"],
    };
  }

  const status = await detectLinger(user);
  if (status === "enabled") {
    return { status, action: "already-enabled", notes: [] };
  }

  const interactive = opts.interactive !== false;
  if (!interactive) {
    return {
      status,
      action: "skipped",
      notes: [
        `Linger is disabled for ${user} — user services will stop on logout.`,
        `Run once to fix: sudo loginctl enable-linger ${user}`,
      ],
    };
  }

  // Ask the user. Default = yes (this is what almost everyone wants).
  const { ok } = await prompts({
    type: "confirm",
    name: "ok",
    message:
      `Linger is disabled for ${user}, so user services will stop when you log out.\n  ` +
      `Enable now? (needs sudo)`,
    initial: true,
  });
  if (!ok) {
    return {
      status,
      action: "declined",
      notes: [
        `Linger left disabled — run this when you're ready:`,
        `  sudo loginctl enable-linger ${user}`,
      ],
    };
  }

  // 1) try sudo -n (no prompt). Works for users with NOPASSWD or a fresh ticket.
  const noPrompt = await execa("sudo", ["-n", "loginctl", "enable-linger", user], { reject: false });
  if (noPrompt.exitCode === 0) {
    cachedStatus = "enabled";
    return { status: "enabled", action: "enabled", notes: [`Linger enabled for ${user}.`] };
  }

  // 2) Interactive sudo — will prompt for password on the TTY.
  if (process.stdin.isTTY) {
    console.log("\nRunning: sudo loginctl enable-linger " + user);
    const interactive = await execa("sudo", ["loginctl", "enable-linger", user], {
      reject: false,
      stdio: "inherit",
    });
    if (interactive.exitCode === 0) {
      cachedStatus = "enabled";
      return { status: "enabled", action: "enabled", notes: [`Linger enabled for ${user}.`] };
    }
  }

  return {
    status,
    action: "failed",
    notes: [
      `Could not enable linger automatically. Run this yourself:`,
      `  sudo loginctl enable-linger ${user}`,
    ],
  };
}

// Reads `loginctl show-user <user> --property=Linger` and parses Linger=yes/no.
// On any unexpected output we return "unknown" rather than guessing — the caller
// surfaces the manual fallback in that case.
async function detectLinger(user: string): Promise<LingerStatus> {
  if (cachedStatus) return cachedStatus;
  const r = await execa(
    "loginctl",
    ["show-user", user, "--property=Linger", "--value"],
    { reject: false },
  );
  if (r.exitCode !== 0) return "unknown";
  const v = (r.stdout ?? "").trim().toLowerCase();
  if (v === "yes" || v === "true" || v === "1") {
    cachedStatus = "enabled";
    return "enabled";
  }
  if (v === "no" || v === "false" || v === "0" || v === "") {
    cachedStatus = "disabled";
    return "disabled";
  }
  return "unknown";
}

// Test seam — reset the cache between runs.
export function _resetLingerCacheForTests(): void {
  cachedStatus = null;
}
