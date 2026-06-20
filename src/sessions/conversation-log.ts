import { mkdir, appendFile, readdir, stat, rm } from "node:fs/promises";
import path from "node:path";
import type { Message } from "../types.js";
import { log } from "../log.js";

// One record per agent turn-loop. Holds the COMPLETE exchange the kernel produced this turn —
// every assistant message (text + tool_use), every tool_result — so the trace reconstructs the
// turn round-by-round. `usage` is the turn's aggregate token spend; `finalText` is the reply.
export interface ConversationLogEntry {
  ts: string; // ISO timestamp
  agent: string;
  sessionId: string;
  model: string;
  isSubagent: boolean;
  turns: number;
  stopReason: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
  };
  // The new messages produced this turn (the kernel's output beyond the replayed history),
  // verbatim — tool_use args and tool_result bodies included. This is the diagnostic payload.
  exchange: Message[];
  finalText: string;
  notices?: string[];
  // The COMPLETE input handed to the model this turn — the system prompt, every tool definition
  // (built-in + MCP), and the replayed message history — so you can see exactly what was sent and
  // why the prompt is the size it is. Image base64 is elided to keep the log readable. The token
  // counts in `usage.inputTokens` are this payload measured by the provider.
  input?: {
    system: string;
    tools: { builtin: unknown[]; mcp: Array<{ server: string; tools: unknown }> };
    messages: Message[];
  };
}

// Append-only JSONL conversation tracer. One file per session per day
// (<sessionId>__<YYYY-MM-DD>.jsonl) so retention can drop whole days without touching active
// conversations. Best-effort throughout: a logging failure must never break a turn, so callers
// wrap nothing — the methods swallow their own errors and only warn.
export class ConversationLog {
  constructor(
    private readonly dir: string,
    private readonly retentionDays: number,
  ) {}

  // Append one turn record. Returns the file path written (for surfacing to the operator), or
  // null if the write failed. Prunes stale files after a successful write.
  async append(entry: ConversationLogEntry): Promise<string | null> {
    const file = this.fileFor(entry.sessionId, entry.ts);
    try {
      await mkdir(this.dir, { recursive: true });
      await appendFile(file, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      log.warn({ err: (err as Error).message, file }, "conversation log: append failed (ignored)");
      return null;
    }
    await this.prune();
    return file;
  }

  // Delete trace files whose last modification is older than retentionDays. Bounds the on-disk
  // window regardless of how long a single conversation lives. Best-effort.
  async prune(): Promise<void> {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    let files: string[];
    try {
      files = await readdir(this.dir);
    } catch {
      return; // dir doesn't exist yet / unreadable — nothing to prune
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const full = path.join(this.dir, f);
      try {
        const s = await stat(full);
        if (s.mtimeMs < cutoff) {
          await rm(full, { force: true });
          log.debug({ file: full }, "conversation log: pruned stale trace");
        }
      } catch {
        /* raced with another writer / already gone — skip */
      }
    }
  }

  private fileFor(sessionId: string, iso: string): string {
    const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const day = iso.slice(0, 10); // YYYY-MM-DD from the ISO timestamp
    return path.join(this.dir, `${safe}__${day}.jsonl`);
  }
}
