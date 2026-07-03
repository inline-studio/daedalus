import type http from "node:http";
import crypto from "node:crypto";
import { log } from "../log.js";

// Remote execution bridge — the server half of the `dae remote` CLI.
//
// A laptop-side client opens an OUTBOUND SSE stream (GET /rpc/stream) and becomes the
// EXECUTOR for its user: when one of that user's turns runs a tool that executes
// remotely (bash, read/write/edit via RemoteRuntime), the request is pushed down this
// stream, the client runs it in its declared workspace, and POSTs the result back
// (/rpc/result). Everything is plain SSE + HTTP on the web channel's existing port and
// auth — no new transport, no inbound connection to the laptop, NAT-friendly.
//
// The third route, POST /rpc/exec, is the INTERNAL bridge: agent containers (where
// RemoteRuntime actually runs) call it to submit a request and block until the laptop
// answers or the timeout fires. It is guarded by a per-boot shared secret
// (DAE_RPC_TOKEN), not user auth — it's supervisor↔agent plumbing, never user-facing.
//
// Request kinds mirror what RemoteRuntime needs: "exec" (shell), "read", "write".

export interface RemoteExecRequest {
  id: string;
  kind: "exec" | "read" | "write";
  // exec
  cmd?: string;
  timeoutMs?: number;
  // read / write
  path?: string;
  content?: string;
}

export interface RemoteExecResult {
  id: string;
  ok: boolean;
  // exec
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  timedOut?: boolean;
  // read
  content?: string;
  // failure detail (refused by the user, file missing, …)
  error?: string;
}

interface Executor {
  res: http.ServerResponse;
  workspace: string;
  connectedAt: string;
  pending: Map<string, { resolve: (r: RemoteExecResult) => void; timer: NodeJS.Timeout }>;
}

export class ExecutorRegistry {
  private byUser = new Map<string, Executor>();

  // Register a freshly-connected executor stream. One executor per user: a new
  // connection replaces the old one (a reconnecting laptop must not be locked out by
  // its own half-dead predecessor), whose pending requests are failed fast.
  register(userId: string, res: http.ServerResponse, workspace: string): void {
    const prev = this.byUser.get(userId);
    if (prev) {
      this.failAll(prev, "executor replaced by a new connection");
      try {
        prev.res.end();
      } catch {
        /* already gone */
      }
    }
    this.byUser.set(userId, {
      res,
      workspace,
      connectedAt: new Date().toISOString(),
      pending: new Map(),
    });
    log.info({ userId, workspace }, "remote-exec: executor connected");
  }

  unregister(userId: string, res: http.ServerResponse): void {
    const ex = this.byUser.get(userId);
    if (!ex || ex.res !== res) return; // a newer connection already took over
    this.failAll(ex, "executor disconnected");
    this.byUser.delete(userId);
    log.info({ userId }, "remote-exec: executor disconnected");
  }

  connected(userId: string): boolean {
    return this.byUser.has(userId);
  }

  info(userId: string): { workspace: string; connectedAt: string } | null {
    const ex = this.byUser.get(userId);
    return ex ? { workspace: ex.workspace, connectedAt: ex.connectedAt } : null;
  }

  // Submit a request to the user's executor and await the result. Rejects fast when no
  // executor is connected; resolves with an error result on timeout.
  submit(
    userId: string,
    req: Omit<RemoteExecRequest, "id">,
    waitMs: number,
  ): Promise<RemoteExecResult> {
    const ex = this.byUser.get(userId);
    if (!ex) {
      return Promise.resolve({
        id: "",
        ok: false,
        error: "no executor connected — is `dae remote` running on the target machine?",
      });
    }
    const id = crypto.randomUUID();
    const full: RemoteExecRequest = { ...req, id };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        ex.pending.delete(id);
        resolve({ id, ok: false, error: `executor did not answer within ${waitMs}ms`, timedOut: true });
      }, waitMs);
      if (typeof timer.unref === "function") timer.unref();
      ex.pending.set(id, { resolve, timer });
      try {
        ex.res.write(`event: request\ndata: ${JSON.stringify(full)}\n\n`);
      } catch {
        clearTimeout(timer);
        ex.pending.delete(id);
        resolve({ id, ok: false, error: "executor stream write failed" });
      }
    });
  }

  // A result arrived from the client. Returns false for unknown/expired ids.
  deliver(userId: string, result: RemoteExecResult): boolean {
    const ex = this.byUser.get(userId);
    const entry = ex?.pending.get(result.id);
    if (!ex || !entry) return false;
    ex.pending.delete(result.id);
    clearTimeout(entry.timer);
    entry.resolve(result);
    return true;
  }

  heartbeatAll(): void {
    for (const ex of this.byUser.values()) {
      try {
        ex.res.write(`event: heartbeat\ndata: {}\n\n`);
      } catch {
        /* close handler cleans up */
      }
    }
  }

  closeAll(): void {
    for (const [userId, ex] of this.byUser) {
      this.failAll(ex, "server shutting down");
      try {
        ex.res.end();
      } catch {
        /* already gone */
      }
      this.byUser.delete(userId);
    }
  }

  private failAll(ex: Executor, reason: string): void {
    for (const [id, entry] of ex.pending) {
      clearTimeout(entry.timer);
      entry.resolve({ id, ok: false, error: reason });
    }
    ex.pending.clear();
  }
}

// The per-boot shared secret guarding the internal /rpc/exec bridge. Generated once per
// supervisor process and forwarded to agent containers via env — it never leaves the
// deployment. Resolution order lets the worker/agent containers receive it from the
// dispatcher while the supervisor generates it.
let rpcToken: string | null = null;
export function getRpcToken(): string {
  if (!rpcToken) rpcToken = process.env.DAE_RPC_TOKEN || crypto.randomBytes(24).toString("hex");
  return rpcToken;
}
