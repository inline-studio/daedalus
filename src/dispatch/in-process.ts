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
  // In-flight turns by sessionId, for abort(). A session runs one top-level turn at a
  // time in practice; a Set keeps overlapping dispatches (e.g. a subagent sharing the
  // map) from clobbering each other.
  private inflight = new Map<string, Set<AbortController>>();
  constructor(private config: ArtemisConfig) {}

  async dispatch(args: DispatchArgs): Promise<DispatchResult> {
    const controller = new AbortController();
    let set = this.inflight.get(args.sessionId);
    if (!set) {
      set = new Set();
      this.inflight.set(args.sessionId, set);
    }
    set.add(controller);
    try {
      return await runAgentTurn({
        config: this.config,
        agentName: args.agentName,
        sessionId: args.sessionId,
        userId: args.userId,
        isSubagent: args.isSubagent,
        ...originFields(args),
        // In-process only: forward the live event sink straight to the turn (no serialization hop).
        ...(args.onEvent ? { onEvent: args.onEvent } : {}),
        ...(args.turnDirective ? { turnDirective: args.turnDirective } : {}),
        ...(args.remoteExec ? { remoteExec: args.remoteExec } : {}),
        signal: controller.signal,
      });
    } finally {
      set.delete(controller);
      if (set.size === 0) this.inflight.delete(args.sessionId);
    }
  }

  async abort(sessionId: string): Promise<boolean> {
    const set = this.inflight.get(sessionId);
    if (!set || set.size === 0) return false;
    for (const c of set) c.abort();
    return true;
  }
}
