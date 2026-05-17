import type { ArtemisConfig } from "../config/schema.js";
import type { AgentDispatcher } from "./base.js";
import { InProcessAgentDispatcher } from "./in-process.js";
import { ContainerAgentDispatcher, dispatcherOptionsFromEnv } from "./container.js";

// Selects the dispatcher based on (in order):
//   1. The DAE_DISPATCHER env var ("process" | "container") — set by docker-compose.
//   2. config.runtime.dispatcher in the YAML.
//   3. Default "process" (host mode).
//
// Mirroring DAE_DISPATCHER into env from the supervisor down to spawned agent
// containers is what makes nested subagent spawns work: the agent container sees
// DAE_DISPATCHER=container and uses the same machinery to spawn its own subagents.
export function buildDispatcher(config: ArtemisConfig): AgentDispatcher {
  const mode = process.env.DAE_DISPATCHER ?? config.runtime.dispatcher ?? "process";
  if (mode === "container") {
    return new ContainerAgentDispatcher(config, dispatcherOptionsFromEnv(config));
  }
  return new InProcessAgentDispatcher(config);
}
