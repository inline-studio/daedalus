// Memory backend interface. Implementations:
//   - MempalaceMcpBackend: thin wrapper that asserts the 'mempalace' MCP server is configured;
//     reads/writes are then performed by the agent itself via that server's tools.
//   - SqliteBackend: future built-in for users who don't want MemPalace.
//
// The runner's job here is mostly orchestration: optional periodic sync of recent memory into
// the brain repo as daily files, so a centralised brain repo carries history across machines.

export interface MemoryEntry {
  timestamp: string; // ISO
  agent: string;
  topic?: string;
  content: string;
}

export interface MemoryBackend {
  readonly id: string;
  // Whether the backend is "live" (e.g., its MCP server is connected).
  isReady(): boolean;
  // Append a raw event. Implementations that store via MCP may make this a no-op
  // and rely on the agent calling memory tools directly.
  append?(entry: MemoryEntry): Promise<void>;
  // Returns recent entries as a plain string for sync-to-disk.
  recent?(limit: number): Promise<MemoryEntry[]>;
}

export class NoopMemoryBackend implements MemoryBackend {
  readonly id = "none";
  isReady(): boolean {
    return true;
  }
}
