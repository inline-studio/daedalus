import type { ToolImpl } from "./base.js";
import { BASH_STREAM_MAX_CHARS, capChars } from "./limits.js";

export const bashTool: ToolImpl = {
  definition: {
    name: "bash",
    description:
      "Run a shell command. If the agent has a container image configured, the command runs inside that container; otherwise it runs on the host. Each stream (stdout/stderr) is truncated to ~16k chars — pipe noisy commands through grep/head/tail to keep output focused.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "Command to execute (passed to /bin/sh -c)." },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds. Default 120000.",
          default: 120_000,
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  async invoke(input, ctx) {
    const cmd = String(input.command ?? "");
    if (!cmd.trim()) return { content: "Error: empty command", isError: true };
    const timeoutMs = typeof input.timeout_ms === "number" ? input.timeout_ms : 120_000;
    // Remote runtime: the command runs on the USER'S machine — server-side paths
    // (shared workspace, skill-bin) don't exist there, and the cwd is the workspace the
    // `dae remote` client declared. Send the command untouched.
    const remote = ctx.runtime.id === "remote";
    // Expose the shared workspace path under one symbol regardless of runtime.
    const env: Record<string, string> = {};
    if (ctx.shared && !remote) {
      env.DAE_SHARED = ctx.runtime.id === "docker" ? ctx.shared.containerPath : ctx.shared.hostPath;
    }
    // Prepend the skill-bin dir to $PATH so binaries installed by skill
    // bootstrap.sh scripts (gh, doctl, agent-browser, …) are discoverable.
    // We don't replace PATH — we extend it — so system binaries still work.
    let prefixedCmd = cmd;
    if (ctx.skillBinDir && !remote) {
      const dir = ctx.runtime.id === "docker"
        ? `${ctx.skillBinDir.containerPath}/bin`
        : `${ctx.skillBinDir.hostPath}/bin`;
      // Use a PATH= prefix on the command instead of env: works regardless of
      // whether the runtime forwards env vars cleanly (DockerRuntime does;
      // HostRuntime does; defensive in case a future runtime is stricter).
      prefixedCmd = `export PATH="${dir}:$PATH"; ${cmd}`;
    }
    const result = await ctx.runtime.exec(prefixedCmd, {
      timeoutMs,
      ...(remote ? {} : { cwd: ctx.runtime.id === "docker" ? "/workspace" : ctx.workspacePath }),
      env,
    });
    const body = [
      result.stdout && `STDOUT:\n${capChars(result.stdout, BASH_STREAM_MAX_CHARS)}`,
      result.stderr && `STDERR:\n${capChars(result.stderr, BASH_STREAM_MAX_CHARS)}`,
      `EXIT: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return { content: body, isError: result.exitCode !== 0 };
  },
};
