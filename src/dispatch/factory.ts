import type { ArtemisConfig } from "../config/schema.js";
import type { AgentDispatcher } from "./base.js";
import { InProcessAgentDispatcher } from "./in-process.js";
import { ContainerAgentDispatcher, dispatcherOptionsFromEnv } from "./container.js";

// Selects the dispatcher based on (in order):
//   1. The DAE_DISPATCHER env var ("container"/"docker" | "process") — set by compose.
//   2. config.runtime.dispatcher in the YAML.
//   3. Default "process".
//
// "docker" is accepted as an alias for "container" — it's the intuitive value to
// reach for, and silently falling back to in-process (losing per-agent container
// isolation) would be a dangerous footgun.
//
// Mirroring DAE_DISPATCHER into env from the supervisor down to spawned agent
// containers is what makes nested subagent spawns work: the agent container sees
// DAE_DISPATCHER=container and uses the same machinery to spawn its own subagents.
export function buildDispatcher(config: ArtemisConfig): AgentDispatcher {
  const mode = process.env.DAE_DISPATCHER ?? config.runtime.dispatcher ?? "process";
  if (mode === "container" || mode === "docker") {
    return new ContainerAgentDispatcher(config, dispatcherOptionsFromEnv(config));
  }
  return new InProcessAgentDispatcher(config);
}
