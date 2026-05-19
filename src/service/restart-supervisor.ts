import { buildServiceManager } from "./factory.js";
import { ServiceUnsupported } from "./base.js";
import { SERVICE_SPECS } from "./specs.js";
import { log } from "../log.js";

// When install / uninstall / service-install touch the data dir, the running
// `dae serve` supervisor can end up holding a stale file descriptor on
// sessions.sqlite — and the next write surfaces as "attempt to write a
// readonly database" hours later when the user sends a Telegram message.
//
// This helper detects whether the daedalus supervisor unit is installed AND
// active. If yes, restart it so it reopens every file from scratch. If no,
// returns a no-op result the caller can surface in the install summary.
//
// SessionStore + ScheduleStore now also self-heal on inode-change (see
// src/sessions/*.ts), so this restart is belt-and-braces — both layers fail
// safe, but together you don't need either to be perfect.

export interface SupervisorRestartResult {
  attempted: boolean;
  restarted: boolean;
  reason: string; // human-readable, suitable for a wizard bullet
}

// The spec id of the daedalus supervisor in src/service/specs.ts. Resolving
// the actual unit name goes through that spec builder so a config-driven name
// override is honoured.
const SUPERVISOR_SPEC_ID = "daedalus";

export async function restartSupervisorIfActive(
  configPath: string | undefined,
): Promise<SupervisorRestartResult> {
  let manager;
  try {
    manager = await buildServiceManager();
  } catch (err) {
    if (err instanceof ServiceUnsupported) {
      return {
        attempted: false,
        restarted: false,
        reason: "no service manager on this platform (nothing to restart)",
      };
    }
    throw err;
  }

  const specBuilder = SERVICE_SPECS[SUPERVISOR_SPEC_ID];
  if (!specBuilder) {
    return {
      attempted: false,
      restarted: false,
      reason: `unknown service spec '${SUPERVISOR_SPEC_ID}' — skipped`,
    };
  }
  let unitName: string;
  try {
    const spec = await specBuilder(configPath);
    if (!spec) {
      return {
        attempted: false,
        restarted: false,
        reason: `spec '${SUPERVISOR_SPEC_ID}' produced no unit — skipped`,
      };
    }
    unitName = spec.name;
  } catch (err) {
    // Spec builders call loadConfig which throws on fresh checkout. That's not
    // an error condition for "should I restart" — it just means there's
    // nothing to restart yet.
    return {
      attempted: false,
      restarted: false,
      reason: `${SUPERVISOR_SPEC_ID}: spec failed to build (${(err as Error).message.split("\n")[0]})`,
    };
  }

  const status = await manager.status(unitName).catch(() => null);
  if (!status || !status.exists) {
    return {
      attempted: false,
      restarted: false,
      reason: `${unitName}: not installed`,
    };
  }
  if (!status.active) {
    return {
      attempted: false,
      restarted: false,
      reason: `${unitName}: installed but not active`,
    };
  }

  try {
    await manager.restart(unitName);
    log.info({ unit: unitName }, "restarted supervisor after install/uninstall");
    return {
      attempted: true,
      restarted: true,
      reason: `${unitName}: restarted (live serve picks up new files)`,
    };
  } catch (err) {
    return {
      attempted: true,
      restarted: false,
      reason: `${unitName}: restart failed (${(err as Error).message})`,
    };
  }
}

// Restart every installed-and-active daedalus-managed service. Used after a
// `dae update` so the supervisor AND its sidecars (dae-whisper,
// dae-mempalace, …) all pick up the new binary / config / image hash.
//
// Idempotent + non-fatal — every spec is checked independently; a missing or
// inactive unit is skipped with a per-spec reason. Returns one result per
// spec considered so the caller can render a summary.
export async function restartAllActiveServices(
  configPath: string | undefined,
): Promise<SupervisorRestartResult[]> {
  let manager;
  try {
    manager = await buildServiceManager();
  } catch (err) {
    if (err instanceof ServiceUnsupported) {
      return [
        {
          attempted: false,
          restarted: false,
          reason: "no service manager on this platform (nothing to restart)",
        },
      ];
    }
    throw err;
  }

  const results: SupervisorRestartResult[] = [];
  for (const specId of Object.keys(SERVICE_SPECS)) {
    const specBuilder = SERVICE_SPECS[specId];
    if (!specBuilder) continue;
    let unitName: string;
    try {
      const spec = await specBuilder(configPath);
      unitName = spec.name;
    } catch (err) {
      results.push({
        attempted: false,
        restarted: false,
        reason: `${specId}: spec failed to build (${(err as Error).message})`,
      });
      continue;
    }

    const status = await manager.status(unitName).catch(() => null);
    if (!status || !status.exists) {
      results.push({ attempted: false, restarted: false, reason: `${unitName}: not installed` });
      continue;
    }
    if (!status.active) {
      results.push({
        attempted: false,
        restarted: false,
        reason: `${unitName}: installed but not active`,
      });
      continue;
    }

    try {
      await manager.restart(unitName);
      log.info({ unit: unitName }, "restarted service after dae update");
      results.push({
        attempted: true,
        restarted: true,
        reason: `${unitName}: restarted`,
      });
    } catch (err) {
      results.push({
        attempted: true,
        restarted: false,
        reason: `${unitName}: restart failed (${(err as Error).message})`,
      });
    }
  }
  return results;
}
