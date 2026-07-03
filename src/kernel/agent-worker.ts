import http from "node:http";
import type { ArtemisConfig } from "../config/schema.js";
import { applyOneCli } from "../secrets/onecli.js";
import { McpPool } from "../mcp/agent-mcp.js";
import { runAgentTurn } from "./agent-turn.js";
import type { DispatchArgs } from "../dispatch/base.js";
import { originFields } from "../dispatch/base.js";
import { log } from "../log.js";

// Long-lived "warm" agent worker. Runs as its own container in the stack (separate
// from the supervisor), so the top-level agent is isolated from the channels +
// supervisor secrets, yet stays warm between turns:
//
//   - OneCLI is applied ONCE at startup (global undici proxy + MITM CA), so no
//     per-turn gateway fetch.
//   - MCP connections live in a persistent McpPool, reused across turns instead of
//     reconnecting every turn.
//
// The supervisor's PersistentContainerDispatcher POSTs each top-level turn here and
// reads the DispatchResult back. Subagent spawns DON'T come here — inside runAgentTurn
// they use the container dispatcher (DAE_DISPATCHER=container in this container's env),
// so each subagent still gets its own ephemeral, isolated container.
export async function runAgentWorker(config: ArtemisConfig): Promise<void> {
  // Warm the OneCLI proxy once for the whole worker lifetime.
  await applyOneCli(config.onecli);

  const pool = new McpPool();
  const port = Number(process.env.DAE_WORKER_PORT ?? 10260);
  // In-flight turns by sessionId — the Stop button's target. The supervisor forwards a
  // user abort here (POST /abort) and the matching turn's AbortSignal fires.
  const inflight = new Map<string, Set<AbortController>>();

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.method === "POST" && req.url === "/turn") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        void handleTurn(config, pool, body, res, inflight);
      });
      return;
    }
    if (req.method === "POST" && req.url === "/abort") {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        let sessionId = "";
        try {
          sessionId = String((JSON.parse(body) as { sessionId?: string }).sessionId ?? "");
        } catch {
          /* fall through to aborted:false */
        }
        const set = sessionId ? inflight.get(sessionId) : undefined;
        if (set) for (const c of set) c.abort();
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ aborted: Boolean(set && set.size) }));
      });
      return;
    }
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, () => resolve());
  });
  log.info({ port }, "agent-worker listening (warm OneCLI + MCP pool)");

  const shutdown = async () => {
    log.info("agent-worker shutting down");
    server.close();
    await pool.closeAll();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleTurn(
  config: ArtemisConfig,
  pool: McpPool,
  body: string,
  res: http.ServerResponse,
  inflight: Map<string, Set<AbortController>>,
): Promise<void> {
  let args: DispatchArgs;
  try {
    args = JSON.parse(body) as DispatchArgs;
  } catch {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "invalid JSON body" }));
    return;
  }
  const controller = new AbortController();
  let set = inflight.get(args.sessionId);
  if (!set) {
    set = new Set();
    inflight.set(args.sessionId, set);
  }
  set.add(controller);
  const releaseInflight = () => {
    set.delete(controller);
    if (set.size === 0) inflight.delete(args.sessionId);
  };
  // Stream the turn as NDJSON: event lines as they happen, then a terminal result/error line.
  // Headers are written lazily on the first line so a failure BEFORE any output can still return
  // a proper HTTP error status; once streaming has begun, errors ride as a final error line.
  let started = false;
  const writeLine = (obj: unknown): void => {
    if (!started) {
      started = true;
      res.writeHead(200, { "content-type": "application/x-ndjson" });
    }
    res.write(JSON.stringify(obj) + "\n");
  };

  try {
    log.info({ agent: args.agentName, session: args.sessionId }, "worker: running turn");
    const result = await runAgentTurn({
      config,
      agentName: args.agentName,
      sessionId: args.sessionId,
      userId: args.userId,
      isSubagent: Boolean(args.isSubagent),
      ...originFields(args),
      ...(args.turnDirective ? { turnDirective: args.turnDirective } : {}),
      ...(args.remoteExec ? { remoteExec: args.remoteExec } : {}),
      mcpPool: pool,
      onEvent: (ev) => writeLine({ kind: "event", event: ev }),
      signal: controller.signal,
    });
    writeLine({ kind: "result", result });
    res.end();
  } catch (err) {
    const aborted = (err as Error).name === "AbortError" || controller.signal.aborted;
    if (aborted) {
      log.info({ agent: args.agentName, session: args.sessionId }, "worker: turn aborted by user");
    } else {
      log.error({ err, agent: args.agentName }, "worker: turn failed");
    }
    const message = aborted ? "turn aborted" : (err as Error).message;
    if (!started) {
      res.writeHead(aborted ? 499 : 500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: message }));
    } else {
      writeLine({ kind: "error", error: message });
      res.end();
    }
  } finally {
    releaseInflight();
  }
}
