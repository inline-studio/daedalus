import { Agent } from "undici";
import type { ArtemisConfig } from "../config/schema.js";
import type { AgentDispatcher, DispatchArgs, DispatchResult } from "./base.js";
import { log } from "../log.js";

// The worker POST must bypass the global undici dispatcher. The supervisor applies
// OneCLI at startup (setGlobalDispatcher → MITM ProxyAgent); routing this internal
// request to dae-worker through that proxy corrupts/fails it ("fetch failed"). The
// worker is on the trusted docker network and needs no credential injection — same
// fix as the MCP client (src/mcp/client.ts) and the transcriber (src/attachments/transcribe.ts).
const directDispatcher = new Agent();

// Supervisor-side dispatcher that hands each top-level turn to the long-lived
// `dae agent-worker` container over HTTP (instead of spawning a fresh container per
// turn). The worker keeps OneCLI + MCP warm, so turns avoid the container cold-start.
//
// Worker location comes from DAE_WORKER_URL (set by docker-compose); defaults to the
// in-stack service name. The worker is a compose service with a healthcheck and the
// supervisor depends_on it being healthy, so it's normally up before the first turn —
// the connection-retry loop only covers a worker restart mid-operation.
export class PersistentContainerDispatcher implements AgentDispatcher {
  readonly id = "persistent";
  private url: string;

  constructor(_config: ArtemisConfig) {
    this.url = (process.env.DAE_WORKER_URL ?? "http://dae-worker:10260").replace(/\/$/, "");
  }

  async dispatch(args: DispatchArgs): Promise<DispatchResult> {
    const body = JSON.stringify({
      agentName: args.agentName,
      sessionId: args.sessionId,
      userId: args.userId,
      isSubagent: args.isSubagent,
    });

    // A turn can take a while (LLM + tools), so don't impose a tight timeout —
    // honor the caller's timeout if any, else a generous ceiling so a wedged worker
    // can't hang the supervisor forever.
    const timeoutMs = args.timeoutMs ?? 10 * 60_000;

    // Retry ONLY on connection-level failures (worker starting / restarting), with a
    // short budget. An HTTP response (even an error) is authoritative — never retry it.
    const connectAttempts = 15;
    let lastErr: unknown;
    for (let attempt = 0; attempt < connectAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${this.url}/turn`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body,
          signal: AbortSignal.timeout(timeoutMs),
          // bypass the OneCLI MITM proxy (see directDispatcher note above)
          dispatcher: directDispatcher,
        } as unknown as RequestInit);
      } catch (err) {
        lastErr = err;
        if (attempt === 0) {
          log.warn({ url: this.url }, "agent worker not reachable yet — retrying");
        }
        await delay(1000);
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        let detail = text.slice(0, 300);
        try {
          const j = JSON.parse(text) as { error?: string };
          if (j.error) detail = j.error;
        } catch {
          /* keep raw text */
        }
        throw new Error(`agent worker turn failed (HTTP ${res.status}): ${detail}`);
      }
      return (await res.json()) as DispatchResult;
    }
    throw new Error(
      `agent worker unreachable at ${this.url}: ${(lastErr as Error)?.message ?? "unknown error"}`,
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
