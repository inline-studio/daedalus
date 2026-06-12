import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import { createHash } from "node:crypto";
import type { LoadedSkill } from "./skills.js";
import { safeChildEnv } from "../secrets/safe-env.js";
import { log } from "../log.js";

// Skill bootstrap convention.
//
// A skill MAY ship a `bootstrap.sh` script next to its SKILL.md. The script's
// contract:
//   - idempotent (fast-path: `command -v <bin> >/dev/null && exit 0`)
//   - installs binaries / runtime deps into the per-skill bin dir we set up
//     for it (passed in as $DAE_SKILL_BIN), so nothing modifies the agent's
//     base image
//   - non-fatal if it can't reach the network — fall through; the skill body
//     should describe a curl fallback
//
// Daedalus runs `bootstrap.sh` ONCE per (skill, content-hash) per install:
//   - the hash is over the script bytes, so editing the script forces a re-run
//   - the marker file lives in the skill-bin root alongside the binaries
//   - failures are logged but don't abort the agent's turn — the user can
//     diagnose via `dae --verbose` and fix
//
// PATH wiring: `skillBinDir(config)/bin` is added to the bash tool's $PATH at
// exec time (see src/tools/bash.ts), so anything the bootstrap drops there
// is on PATH for the rest of the run.
//
// File layout under skillBinDir:
//   bin/                   shared bin dir on $PATH for every skill
//   <skillName>/           per-skill scratch dir ($DAE_SKILL_BIN); skills can
//                          put npm prefixes, gem homes, venvs etc here
//   .bootstrap/            marker files keyed by skill+hash so we know what's
//                          already done

export interface SkillBootstrapResult {
  ran: boolean;            // did we execute the script this turn?
  alreadyDone: boolean;    // was the script-hash marker already present?
  exitCode: number | null;
  stderrTail: string;
}

export function skillBinRoot(dataDir: string): string {
  return path.join(dataDir, "skill-bin");
}

export function sharedBinDir(dataDir: string): string {
  return path.join(skillBinRoot(dataDir), "bin");
}

export function perSkillDir(dataDir: string, skillName: string): string {
  return path.join(skillBinRoot(dataDir), skillName);
}

function markerPath(dataDir: string, skillName: string, scriptHash: string): string {
  return path.join(skillBinRoot(dataDir), ".bootstrap", `${skillName}-${scriptHash}.ok`);
}

// Run any skill's bootstrap.sh that hasn't already been run for its current
// content. Returns one result per skill that has a bootstrap script (skills
// without one are silently skipped).
//
// Idempotent + parallel-safe within a single process (we await sequentially);
// across processes the marker check makes a duplicate bootstrap a no-op.
export async function runSkillBootstraps(
  skills: LoadedSkill[],
  dataDir: string,
): Promise<Map<string, SkillBootstrapResult>> {
  const out = new Map<string, SkillBootstrapResult>();
  await ensureLayout(dataDir);
  for (const skill of skills) {
    const scriptPath = path.join(skill.rootPath, "bootstrap.sh");
    if (!fs.existsSync(scriptPath)) continue;
    try {
      const result = await runOne(skill.manifest.name, scriptPath, dataDir);
      out.set(skill.manifest.name, result);
    } catch (err) {
      log.error(
        { skill: skill.manifest.name, err },
        "skill bootstrap threw — skill will load with whatever's already on PATH",
      );
      out.set(skill.manifest.name, {
        ran: true,
        alreadyDone: false,
        exitCode: null,
        stderrTail: (err as Error).message,
      });
    }
  }
  return out;
}

async function runOne(
  skillName: string,
  scriptPath: string,
  dataDir: string,
): Promise<SkillBootstrapResult> {
  const scriptBytes = await fsp.readFile(scriptPath);
  const hash = createHash("sha256").update(scriptBytes).digest("hex").slice(0, 16);
  const marker = markerPath(dataDir, skillName, hash);
  if (fs.existsSync(marker)) {
    return { ran: false, alreadyDone: true, exitCode: 0, stderrTail: "" };
  }

  const binDir = sharedBinDir(dataDir);
  const skillDir = perSkillDir(dataDir, skillName);
  await fsp.mkdir(binDir, { recursive: true });
  await fsp.mkdir(skillDir, { recursive: true });

  log.info({ skill: skillName, scriptHash: hash }, "running skill bootstrap");

  // Run via /bin/sh explicitly so the script doesn't need its own +x bit.
  // 5-minute hard cap — generous for an apt-get / npm install / binary
  // download; long enough that a stuck script won't wedge an agent turn.
  const result = await execa("/bin/sh", [scriptPath], {
    // SEC-11: hand the script only allowlisted operational env (PATH/HOME/locale + OneCLI
    // proxy/CA so npm/curl/gh still work), NOT the supervisor's secrets. The DAE_SKILL_* vars
    // and the bin-dir PATH prefix layer on top. extendEnv:false is REQUIRED — execa otherwise
    // merges the full process.env back in, defeating the allowlist.
    env: {
      ...safeChildEnv(),
      DAE_SKILL_BIN: skillDir,
      DAE_SKILL_PATH_DIR: binDir,
      PATH: `${binDir}:${process.env.PATH ?? "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"}`,
    },
    extendEnv: false,
    timeout: 5 * 60_000,
    reject: false,
  });

  const stderrTail = (result.stderr ?? "").split(/\r?\n/).slice(-10).join("\n");

  if (result.exitCode === 0) {
    // Atomic marker write so a crash mid-bootstrap doesn't leave a stale ok.
    await fsp.mkdir(path.dirname(marker), { recursive: true });
    await fsp.writeFile(marker, `${new Date().toISOString()}\n`, "utf8");
    log.info({ skill: skillName }, "skill bootstrap ok");
    return { ran: true, alreadyDone: false, exitCode: 0, stderrTail };
  }

  log.warn(
    { skill: skillName, exitCode: result.exitCode, stderrTail },
    "skill bootstrap failed — skill loads anyway, agent should fall back per SKILL.md",
  );
  return {
    ran: true,
    alreadyDone: false,
    exitCode: result.exitCode ?? null,
    stderrTail,
  };
}

async function ensureLayout(dataDir: string): Promise<void> {
  await fsp.mkdir(sharedBinDir(dataDir), { recursive: true });
  await fsp.mkdir(path.join(skillBinRoot(dataDir), ".bootstrap"), { recursive: true });
}
