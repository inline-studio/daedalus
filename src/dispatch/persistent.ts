import { Agent } from "undici";
import type { ArtemisConfig } from "../config/schema.js";
import type { AgentDispatcher, DispatchArgs, DispatchResult } from "./base.js";
import { originFields } from "./base.js";
import type { TurnEventSink } from "../types.js";
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
  readonly streaming = true;
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
      ...originFields(args),
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
      // The worker streams its turn as NDJSON: event lines (forwarded to the caller's sink) then
      // a terminal result/error line. A mid-stream failure is NOT retried — events may already
      // have been forwarded, so re-running would double them.
      return this.consumeStream(res, args.onEvent);
    }
    throw new Error(
      `agent worker unreachable at ${this.url}: ${(lastErr as Error)?.message ?? "unknown error"}`,
    );
  }

  // Parse the worker's NDJSON turn stream: forward each event line to `onEvent` (when present)
  // and return the terminal result. Throws on an error line or a stream that ends without one.
  private async consumeStream(res: Response, onEvent?: TurnEventSink): Promise<DispatchResult> {
    const body = res.body as ReadableStream<Uint8Array> | null;
    if (!body) throw new Error("agent worker returned no response body");
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let result: DispatchResult | undefined;

    const handle = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const msg = JSON.parse(trimmed) as
        | { kind: "event"; event: Parameters<TurnEventSink>[0] }
        | { kind: "result"; result: DispatchResult }
        | { kind: "error"; error: string };
      if (msg.kind === "event") {
        if (onEvent) onEvent(msg.event);
      } else if (msg.kind === "result") {
        result = msg.result;
      } else if (msg.kind === "error") {
        throw new Error(`agent worker turn failed: ${msg.error}`);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        handle(line);
      }
    }
    if (buf.trim()) handle(buf);

    if (!result) throw new Error("agent worker stream ended without a result");
    // BUG-18: validate the result shape before trusting it as a DispatchResult.
    if (result.status !== "complete" && result.status !== "pending_question") {
      throw new Error(
        `agent worker returned an invalid result shape: ${JSON.stringify(result)?.slice(0, 200)}`,
      );
    }
    return result;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
