import type { MemoryBackend } from "./base.js";
import type { ConnectedServer } from "../mcp/client.js";
import { log } from "../log.js";

// MemPalace integration is mostly "use the existing MCP server".
// The agent is exposed to the mempalace MCP tools via the standard MCP loader; this
// class just verifies the server is connected and surfaces health / sync hooks.
export class MempalaceMcpBackend implements MemoryBackend {
  readonly id = "mempalace";

  constructor(private getServer: () => ConnectedServer | undefined) {}

  isReady(): boolean {
    const s = this.getServer();
    if (!s) {
      log.warn("memory.backend=mempalace but no MCP server named 'mempalace' is connected");
      return false;
    }
    return true;
  }
}
