import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load.js";
import type { ServiceSpec } from "./base.js";

// Predefined service specs the user can install via `dae service install <name>`.
//
// Each builder reads the current config to figure out the right paths/args. Specs are
// resolved against the user's runtime — e.g. the daedalus spec uses the same Node binary
// and dist/index.js path the running CLI is invoked from.

export type SpecBuilder = (configPath: string | undefined) => Promise<ServiceSpec>;

const LOGS_DIR = path.join(os.homedir(), ".daedalus", "logs");

export const SERVICE_SPECS: Record<string, SpecBuilder> = {
  daedalus: async (configPath) => {
    const config = loadConfig(configPath);
    const node = process.execPath;
    // dist/index.js relative to this compiled file (dist/service/specs.js → dist/index.js).
    const here = path.dirname(fileURLToPath(import.meta.url));
    const indexPath = path.resolve(here, "..", "index.js");
    const args: string[] = [];
    if (configPath) args.push("-c", path.resolve(configPath));
    args.push("serve");
    return {
      name: "dae",
      description: "Daedalus runner — listens on configured channels and runs scheduled agents",
      exec: node,
      args: [indexPath, ...args],
      workingDir: path.dirname(path.resolve(configPath ?? process.cwd())),
      restart: "on-failure",
      restartDelaySec: 5,
      env: { NODE_ENV: "production" },
      logsDir: LOGS_DIR,
    };
  },

  whisper: async (configPath) => {
    const config = loadConfig(configPath);
    const port = portFromBaseUrl(config.transcribe.baseUrl);
    if (config.transcribe.runMode === "docker") {
      return {
        name: "dae-whisper",
        description: "faster-whisper-server in Docker (STT) — managed by daedalus",
        exec: "docker",
        args: ["run", "--rm", "-p", `${port}:8000`, "fedirz/faster-whisper-server:latest"],
        restart: "on-failure",
        restartDelaySec: 5,
        logsDir: LOGS_DIR,
      };
    }
    return {
      name: "dae-whisper",
      description: "faster-whisper-server (local STT) — managed by daedalus",
      exec: "faster-whisper-server",
      args: ["--host", "127.0.0.1", "--port", String(port)],
      restart: "on-failure",
      restartDelaySec: 5,
      logsDir: LOGS_DIR,
    };
  },

  mempalace: async (configPath) => {
    // Local-HTTP MemPalace daemon. Only relevant when `dae setup mempalace` was run
    // in `local-http` mode — that's where the launch command + port come from.
    const config = loadConfig(configPath);
    const lh = config.mempalace.localHttp;
    if (!lh.enabled) {
      throw new Error(
        "mempalace.localHttp.enabled is false — run `dae setup mempalace` and pick local-http first.",
      );
    }
    return {
      name: "dae-mempalace",
      description: `MemPalace HTTP daemon — managed by daedalus (port ${lh.port}, host ${lh.host})`,
      exec: lh.command,
      args: lh.args,
      restart: "on-failure",
      restartDelaySec: 5,
      // Pass MEMPALACE_TOKEN through so mempalace can validate incoming Bearer auth.
      env: { ...(process.env.MEMPALACE_TOKEN ? { MEMPALACE_TOKEN: process.env.MEMPALACE_TOKEN } : {}) },
      logsDir: LOGS_DIR,
    };
  },
};

function portFromBaseUrl(baseUrl: string | undefined): number {
  if (!baseUrl) return 8000;
  try {
    const u = new URL(baseUrl);
    return u.port ? Number(u.port) : 8000;
  } catch {
    return 8000;
  }
}
