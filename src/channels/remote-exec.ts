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
  id: string; // client-generated, stable per client process — lets a machine reconnect over its own zombie
  res: http.ServerResponse;
  workspace: string;
  connectedAt: string;
  // Machine description the client registered with (hostname/platform/arch) — feeds the
  // turn's execution-environment context line.
  env: Record<string, string>;
  pending: Map<string, { resolve: (r: RemoteExecResult) => void; timer: NodeJS.Timeout }>;
}

export class ExecutorRegistry {
  // Many executors per user — the normal topology is a CLI on several machines plus a
  // desktop app on another, all one user. Each connection carries a client-generated
  // executorId; turns route to the executor of the client that SENT them, falling back
  // to the most recently connected machine (phone/Telegram turns have no local client).
  private byUser = new Map<string, Map<string, Executor>>();

  // Register a freshly-connected executor stream. Same executorId = the same client
  // process reconnecting: replace its predecessor (a laptop must not be locked out by
  // its own half-dead stream) and tell it, so a genuinely-alive duplicate stands down
  // instead of ping-ponging. Different ids coexist.
  register(
    userId: string,
    executorId: string,
    res: http.ServerResponse,
    workspace: string,
    env: Record<string, string> = {},
  ): void {
    let all = this.byUser.get(userId);
    if (!all) {
      all = new Map();
      this.byUser.set(userId, all);
    }
    const prev = all.get(executorId);
    if (prev) {
      this.failAll(prev, "executor replaced by a new connection");
      try {
        prev.res.write(`event: replaced\ndata: {}\n\n`);
        prev.res.end();
      } catch {
        /* already gone */
      }
    }
    all.set(executorId, {
      id: executorId,
      res,
      workspace,
      connectedAt: new Date().toISOString(),
      env,
      pending: new Map(),
    });
    log.info({ userId, executorId, workspace, ...env }, "remote-exec: executor connected");
  }

  unregister(userId: string, executorId: string, res: http.ServerResponse): void {
    const all = this.byUser.get(userId);
    const ex = all?.get(executorId);
    if (!all || !ex || ex.res !== res) return; // a newer connection already took over
    this.failAll(ex, "executor disconnected");
    all.delete(executorId);
    if (all.size === 0) this.byUser.delete(userId);
    log.info({ userId, executorId }, "remote-exec: executor disconnected");
  }

  // The executor a request should target: the named one when alive, else the most
  // recently connected (turns from clients without an executor — phone, plain web).
  private pick(userId: string, executorId?: string): Executor | null {
    const all = this.byUser.get(userId);
    if (!all || all.size === 0) return null;
    if (executorId) {
      const named = all.get(executorId);
      if (named) return named;
    }
    let newest: Executor | null = null;
    for (const ex of all.values()) {
      if (!newest || ex.connectedAt > newest.connectedAt) newest = ex;
    }
    return newest;
  }

  connected(userId: string, executorId?: string): boolean {
    if (!executorId) return (this.byUser.get(userId)?.size ?? 0) > 0;
    return Boolean(this.byUser.get(userId)?.has(executorId));
  }

  info(
    userId: string,
    executorId?: string,
  ): { id: string; workspace: string; connectedAt: string; env: Record<string, string> } | null {
    const ex = this.pick(userId, executorId);
    return ex ? { id: ex.id, workspace: ex.workspace, connectedAt: ex.connectedAt, env: ex.env } : null;
  }

  // Every connected machine for this user (the /status executors listing).
  list(userId: string): Array<{ id: string; workspace: string; connectedAt: string; env: Record<string, string> }> {
    return [...(this.byUser.get(userId)?.values() ?? [])].map((ex) => ({
      id: ex.id,
      workspace: ex.workspace,
      connectedAt: ex.connectedAt,
      env: ex.env,
    }));
  }

  // Submit a request to one of the user's executors and await the result. Rejects fast
  // when none is connected; resolves with an error result on timeout.
  submit(
    userId: string,
    req: Omit<RemoteExecRequest, "id">,
    waitMs: number,
    executorId?: string,
  ): Promise<RemoteExecResult> {
    const ex = this.pick(userId, executorId);
    if (!ex) {
      return Promise.resolve({
        id: "",
        ok: false,
        error: "no executor connected — is `dae` or the desktop app running on the target machine?",
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

  // A result arrived from the client. Request ids are unique per submission, so search
  // every executor the user has. Returns false for unknown/expired ids.
  deliver(userId: string, result: RemoteExecResult): boolean {
    for (const ex of this.byUser.get(userId)?.values() ?? []) {
      const entry = ex.pending.get(result.id);
      if (!entry) continue;
      ex.pending.delete(result.id);
      clearTimeout(entry.timer);
      entry.resolve(result);
      return true;
    }
    return false;
  }

  heartbeatAll(): void {
    for (const all of this.byUser.values()) {
      for (const ex of all.values()) {
        try {
          ex.res.write(`event: heartbeat\ndata: {}\n\n`);
        } catch {
          /* close handler cleans up */
        }
      }
    }
  }

  closeAll(): void {
    for (const [userId, all] of this.byUser) {
      for (const ex of all.values()) {
        this.failAll(ex, "server shutting down");
        try {
          ex.res.end();
        } catch {
          /* already gone */
        }
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
