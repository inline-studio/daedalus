import fs from "node:fs/promises";
import path from "node:path";
import { Cron } from "croner";
import type { MemoryBackend } from "./base.js";
import { log } from "../log.js";

// Periodic sync of recent memory into BRAIN_PATH/memory/<YYYY-MM-DD>/.
// Disabled unless config.memory.brainSync.enabled. Backend must implement recent().
export interface BrainSyncOptions {
  schedule: string;
  outputDir: string;
  agentName?: string;
}

export function startBrainSync(backend: MemoryBackend, opts: BrainSyncOptions): { stop(): void } {
  if (!backend.recent) {
    log.warn({ backend: backend.id }, "Brain-sync requested but backend has no recent() — skipping");
    return { stop() {} };
  }

  const job = new Cron(opts.schedule, async () => {
    try {
      const entries = await backend.recent!(500);
      if (!entries.length) return;
      const day = new Date().toISOString().slice(0, 10);
      const dir = path.join(opts.outputDir, day);
      await fs.mkdir(dir, { recursive: true });
      const filename = opts.agentName ? `${opts.agentName}.md` : "session.md";
      const file = path.join(dir, filename);

      const body = entries
        .map((e) => `### ${e.timestamp}${e.topic ? ` — ${e.topic}` : ""}\n\n${e.content}`)
        .join("\n\n");
      await fs.writeFile(file, body, "utf8");
      log.info({ file, count: entries.length }, "brain-sync wrote memory snapshot");
    } catch (err) {
      log.error({ err }, "brain-sync failed");
    }
  });

  return {
    stop() {
      job.stop();
    },
  };
}
