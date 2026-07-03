import type { Runtime, ExecOptions, ExecResult } from "./base.js";
import type { RemoteExecResult } from "../channels/remote-exec.js";

// RemoteRuntime — tool execution on the USER'S machine via the supervisor's remote-exec
// bridge. The agent turn (running in its container or the warm worker) POSTs each
// request to the supervisor's internal /rpc/exec; the supervisor pushes it down the
// connected `dae remote` client's SSE stream; the client runs it in its workspace and
// answers. Buffered, like every other runtime — the result comes back whole.
//
// Failure shape: bridge/transport problems surface as a failed exec (exit 124-ish text)
// or a thrown error for file ops — never a hang; every layer has a timeout.

export interface RemoteRuntimeOptions {
  // The supervisor's internal bridge, e.g. http://daedalus:8765 or http://127.0.0.1:8765.
  url: string;
  // Per-boot shared secret (DAE_RPC_TOKEN) guarding /rpc/exec.
  token: string;
  // The daedalus-internal user id whose executor should run our requests.
  userId: string;
}

export class RemoteRuntime implements Runtime {
  readonly id = "remote";

  constructor(private opts: RemoteRuntimeOptions) {}

  private async call(body: Record<string, unknown>, waitMs: number): Promise<RemoteExecResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), waitMs + 15_000);
    try {
      const res = await fetch(`${this.opts.url.replace(/\/$/, "")}/rpc/exec`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-dae-rpc-token": this.opts.token,
        },
        body: JSON.stringify({ userId: this.opts.userId, ...body }),
        signal: controller.signal,
      });
      if (!res.ok) {
        return { id: "", ok: false, error: `remote-exec bridge returned ${res.status}` };
      }
      return (await res.json()) as RemoteExecResult;
    } catch (err) {
      return { id: "", ok: false, error: `remote-exec bridge unreachable: ${(err as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const r = await this.call({ kind: "exec", cmd, timeoutMs }, timeoutMs);
    if (!r.ok && r.stdout === undefined && r.exitCode === undefined) {
      // Transport/bridge failure or user refusal — surface as a failed command so the
      // agent sees exactly what happened and can adapt (e.g. tell the user).
      return {
        stdout: "",
        stderr: `[remote execution failed] ${r.error ?? "unknown error"}`,
        exitCode: 124,
        timedOut: Boolean(r.timedOut),
      };
    }
    return {
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
      exitCode: r.exitCode ?? (r.ok ? 0 : 1),
      timedOut: Boolean(r.timedOut),
    };
  }

  async readFile(path: string): Promise<string> {
    const r = await this.call({ kind: "read", path }, 30_000);
    if (!r.ok) throw new Error(r.error ?? `remote read of '${path}' failed`);
    return r.content ?? "";
  }

  async writeFile(path: string, content: string): Promise<void> {
    const r = await this.call({ kind: "write", path, content }, 30_000);
    if (!r.ok) throw new Error(r.error ?? `remote write of '${path}' failed`);
  }
}
