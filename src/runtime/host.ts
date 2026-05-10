import { execa } from "execa";
import type { ExecOptions, ExecResult, Runtime } from "./base.js";

// Runs commands directly on the host. Use only when sandboxing is not required.
// Bind mounts are ignored (the host already has filesystem access).
export class HostRuntime implements Runtime {
  readonly id = "host" as const;

  async exec(cmd: string, opts: ExecOptions): Promise<ExecResult> {
    try {
      const result = await execa({
        shell: true,
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
        timeout: opts.timeoutMs ?? 120_000,
        reject: false,
        all: false,
      })`${cmd}`;
      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.exitCode ?? 1,
        timedOut: result.timedOut ?? false,
      };
    } catch (err) {
      const e = err as Error & { stdout?: string; stderr?: string };
      return {
        stdout: e.stdout ?? "",
        stderr: e.stderr ?? e.message,
        exitCode: 1,
        timedOut: false,
      };
    }
  }
}
