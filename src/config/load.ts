import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import dotenv from "dotenv";
import { ArtemisConfigSchema, type ArtemisConfig } from "./schema.js";

// Per-user config directory (~/.daedalus/). Used as the last fallback when no project-local
// config is present, and as the storage location for a globally-installed `dae` CLI.
function userConfigDir(): string {
  return path.join(os.homedir(), ".daedalus");
}

const ENV_REF = /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g;

export function expandEnv<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(ENV_REF, (_m, key, fallback) => {
      const v = process.env[key];
      if (v !== undefined && v !== "") return v;
      if (fallback !== undefined) return fallback;
      return "";
    }) as unknown as T;
  }
  if (Array.isArray(value)) return value.map(expandEnv) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandEnv(v);
    return out as unknown as T;
  }
  return value;
}

export function loadConfig(configPath?: string): ArtemisConfig {
  const userDir = userConfigDir();
  const candidates = configPath
    ? [configPath]
    : [
        process.env.DAE_CONFIG,
        path.join(process.cwd(), "daedalus.config.yaml"),
        path.join(process.cwd(), "daedalus.config.yml"),
        path.join(process.cwd(), "daedalus.config.json"),
        // User-global fallback so a `npm link`'d `dae` works from any cwd.
        path.join(userDir, "config.yaml"),
        path.join(userDir, "daedalus.config.yaml"),
        path.join(userDir, "config.yml"),
      ].filter((p): p is string => Boolean(p));

  let raw: unknown = null;
  let usedPath: string | null = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf8");
      raw = p.endsWith(".json") ? JSON.parse(text) : YAML.parse(text);
      usedPath = p;
      break;
    }
  }

  if (!raw) {
    // Allow env-only config: BRAIN_PATH plus provider keys.
    const brain = process.env.BRAIN_PATH;
    if (!brain) {
      throw new Error(
        "No daedalus.config.yaml found and BRAIN_PATH is not set. Create a config file at " +
          `${path.join(userDir, "config.yaml")} (per-user) or ./daedalus.config.yaml (project-local), ` +
          "or export BRAIN_PATH.",
      );
    }
    raw = { brain: { path: brain, writable: process.env.BRAIN_WRITABLE === "1" } };
  }

  // Once we know which config file was picked, load that directory's .env / .env.local on
  // top of any cwd-loaded values. This makes `~/.daedalus/.env.local` work for a global CLI
  // run from anywhere, while project-local .env.local still wins (it loads first via
  // src/index.ts and override:false here means we don't clobber what's already set).
  if (usedPath) {
    const cfgDir = path.dirname(usedPath);
    if (cfgDir !== process.cwd()) {
      dotenv.config({ path: path.join(cfgDir, ".env"), override: false });
      dotenv.config({ path: path.join(cfgDir, ".env.local"), override: false });
    }
  }

  const expanded = expandEnv(raw);
  const parsed = ArtemisConfigSchema.parse(expanded);

  // env override pass
  if (process.env.BRAIN_PATH) parsed.brain.path = process.env.BRAIN_PATH;
  if (process.env.BRAIN_WRITABLE === "1") parsed.brain.writable = true;
  // Container-path overrides. The docker image sets these (DAE_DATA_DIR=/data,
  // DAE_SHARED_DIR=/shared) so a SINGLE config — with host-friendly paths for
  // host-side commands (`dae install`, `dae export`) — also works unchanged inside
  // the supervisor container, where persistent state lives at the conventional volume
  // mount points. Unset on the host, so host runs keep using the config's own paths.
  if (process.env.DAE_DATA_DIR) {
    parsed.sessions.dbPath = path.join(process.env.DAE_DATA_DIR, "sessions.sqlite");
    parsed.sessions.attachmentsPath = path.join(process.env.DAE_DATA_DIR, "attachments");
  }
  if (process.env.DAE_SHARED_DIR) parsed.runtime.shared.hostPath = process.env.DAE_SHARED_DIR;

  // Resolve all relative paths against the config file's directory (or cwd if env-only).
  const baseDir = usedPath ? path.dirname(usedPath) : process.cwd();
  const resolveRel = (p: string | undefined): string | undefined =>
    p && !path.isAbsolute(p) ? path.resolve(baseDir, p) : p;

  if (!path.isAbsolute(parsed.brain.path)) {
    parsed.brain.path = path.resolve(baseDir, parsed.brain.path);
  }
  if (parsed.mcp.configPath) parsed.mcp.configPath = resolveRel(parsed.mcp.configPath)!;
  if (parsed.memory.brainSync.path) {
    parsed.memory.brainSync.path = resolveRel(parsed.memory.brainSync.path)!;
  }
  parsed.sessions.dbPath = resolveRel(parsed.sessions.dbPath)!;
  parsed.sessions.attachmentsPath = resolveRel(parsed.sessions.attachmentsPath)!;
  parsed.runtime.shared.hostPath = resolveRel(parsed.runtime.shared.hostPath)!;

  return parsed;
}
