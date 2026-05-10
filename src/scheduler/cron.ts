import fs from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import YAML from "yaml";
import { z } from "zod";
import { log } from "../log.js";
import type { ArtemisConfig } from "../config/schema.js";
import { runAgent } from "../kernel/run.js";
import { loadAgent } from "../brain/agents.js";

// brain/schedules/<name>.yaml
const ScheduleSchema = z.object({
  name: z.string(),
  agent: z.string(),
  schedule: z.string(), // cron expression
  prompt: z.string(),
  enabled: z.boolean().default(true),
});
export type Schedule = z.infer<typeof ScheduleSchema>;

export interface RunningSchedule {
  schedule: Schedule;
  job: Cron;
}

export async function loadSchedules(brainPath: string): Promise<Schedule[]> {
  const dir = path.join(brainPath, "schedules");
  let files: string[];
  try {
    files = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"));
  } catch {
    return [];
  }
  const out: Schedule[] = [];
  for (const f of files) {
    const text = await fs.readFile(path.join(dir, f), "utf8");
    try {
      out.push(ScheduleSchema.parse(YAML.parse(text)));
    } catch (err) {
      log.error({ file: f, err }, "invalid schedule");
    }
  }
  return out;
}

export function startScheduler(config: ArtemisConfig, schedules: Schedule[]): RunningSchedule[] {
  const running: RunningSchedule[] = [];
  for (const s of schedules) {
    if (!s.enabled) continue;
    const job = new Cron(s.schedule, async () => {
      try {
        const a = await loadAgent(config.brain.path, s.agent);
        const r = await runAgent({
          config,
          agent: a.manifest,
          agentBody: a.body,
          prompt: s.prompt,
        });
        log.info({ schedule: s.name, turns: r.turns }, "scheduled run complete");
      } catch (err) {
        log.error({ schedule: s.name, err }, "scheduled run failed");
      }
    });
    running.push({ schedule: s, job });
    log.info({ name: s.name, expr: s.schedule }, "schedule armed");
  }
  return running;
}
