import type { ArtemisConfig } from "../config/schema.js";
import type { AgentDispatcher, DispatchArgs, DispatchResult } from "./base.js";
import { originFields } from "./base.js";
import { runAgentTurn } from "../kernel/agent-turn.js";

// Runs one agent turn directly in this Node process. Used by:
//   - the supervisor in host mode (`runtime.dispatcher: process`)
//   - any subagent dispatch where the parent has opted for in-process delegation
export class InProcessAgentDispatcher implements AgentDispatcher {
  readonly id = "in-process";
  readonly streaming = true;
  constructor(private config: ArtemisConfig) {}
  async dispatch(args: DispatchArgs): Promise<DispatchResult> {
    return runAgentTurn({
      config: this.config,
      agentName: args.agentName,
      sessionId: args.sessionId,
      userId: args.userId,
      isSubagent: args.isSubagent,
      ...originFields(args),
      // In-process only: forward the live event sink straight to the turn (no serialization hop).
      ...(args.onEvent ? { onEvent: args.onEvent } : {}),
      ...(args.turnDirective ? { turnDirective: args.turnDirective } : {}),
    });
  }
}
