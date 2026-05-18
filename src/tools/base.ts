import type { ToolDefinition } from "../types.js";
import type { Runtime } from "../runtime/base.js";

export interface ToolContext {
  runtime: Runtime;
  brainPath: string;
  brainWritable: boolean;
  workspacePath: string; // host-side workspace dir (may map to /workspace in container)
  agentName: string;
  // Cross-agent persistent storage. When enabled, ARTEMIS_SHARED env var points here;
  // host-runtime agents see hostPath, container agents see containerPath.
  shared?: { hostPath: string; containerPath: string };
  // Persistent directory that skills install binaries into via bootstrap.sh.
  // The bash tool prepends `${skillBinDir}/bin` to $PATH so anything dropped
  // there (gh, doctl, agent-browser, etc.) is discoverable without baking
  // into the agent image.
  skillBinDir?: { hostPath: string; containerPath: string };
}

export interface ToolImpl {
  definition: ToolDefinition;
  invoke(input: Record<string, unknown>, ctx: ToolContext): Promise<{ content: string; isError?: boolean }>;
}

export class ToolError extends Error {}
