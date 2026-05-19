import type { ToolImpl } from "./base.js";

export const bashTool: ToolImpl = {
  definition: {
    name: "bash",
    description:
      "Run a shell command. If the agent has a container image configured, the command runs inside that container; otherwise it runs on the host. Output is truncated to 30k chars.",
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
    // Expose the shared workspace path under one symbol regardless of runtime.
    const env: Record<string, string> = {};
    if (ctx.shared) {
      env.DAE_SHARED = ctx.runtime.id === "docker" ? ctx.shared.containerPath : ctx.shared.hostPath;
    }
    // Prepend the skill-bin dir to $PATH so binaries installed by skill
    // bootstrap.sh scripts (gh, doctl, agent-browser, …) are discoverable.
    // We don't replace PATH — we extend it — so system binaries still work.
    let prefixedCmd = cmd;
    if (ctx.skillBinDir) {
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
      cwd: ctx.runtime.id === "docker" ? "/workspace" : ctx.workspacePath,
      env,
    });
    const truncate = (s: string) => (s.length > 30_000 ? s.slice(0, 30_000) + "\n[truncated]" : s);
    const body = [
      result.stdout && `STDOUT:\n${truncate(result.stdout)}`,
      result.stderr && `STDERR:\n${truncate(result.stderr)}`,
      `EXIT: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    return { content: body, isError: result.exitCode !== 0 };
  },
};
