import type { AgentDispatcher, DispatchArgs, DispatchResult } from "../dispatch/base.js";
import type { TurnEvent, TurnEventSink } from "../types.js";

// Live activity: what every agent is doing RIGHT NOW, across all of a user's
// conversations and scheduled turns. The registry is fed by wrapping the supervisor's
// dispatcher — the single choke point every top-level turn flows through (channel
// inbounds, static cron fires, agent-armed schedule fires) — so nothing needs
// per-call-site instrumentation. Sub-agent dispatches are skipped (their detail arrives
// via the parent turn's origin-tagged events); in docker mode they run in other
// processes anyway.
//
// Powers GET /activity → the sidebar ACTIVITY section and the CLI's /activity — and
// pairs with the Stop button: see a runaway turn anywhere, stop it from here.

export interface ActiveTurn {
  conversationId: string;
  userId: string;
  agent: string;
  channel: string;
  startedAt: string; // ISO
  // Human-readable "what it's doing right now": thinking / replying / tool: bash /
  // cypher › bash / finishing. Coarse by design — the conversation has the detail.
  activity: string;
}

export class ActivityRegistry {
  private turns = new Map<string, ActiveTurn>(); // keyed by sessionId (one top-level turn at a time)

  start(t: ActiveTurn): void {
    this.turns.set(t.conversationId, t);
  }

  update(conversationId: string, activity: string): void {
    const t = this.turns.get(conversationId);
    if (t && t.activity !== activity) t.activity = activity;
  }

  end(conversationId: string): void {
    this.turns.delete(conversationId);
  }

  listForUser(userId: string): ActiveTurn[] {
    const out: ActiveTurn[] = [];
    for (const t of this.turns.values()) if (t.userId === userId) out.push(t);
    return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  size(): number {
    return this.turns.size;
  }
}

// A one-line activity label from a turn event. Origin-tagged events name the sub-agent
// chain so delegated work reads as "cypher › bash".
export function activityLabel(ev: TurnEvent): string | null {
  const prefix = ev.origin?.path?.length ? ev.origin.path.join(" › ") + " · " : "";
  switch (ev.type) {
    case "thinking_delta":
      return prefix + "thinking";
    case "text_delta":
      return prefix + "replying";
    case "tool_running":
    case "tool_use":
      return prefix + `tool: ${ev.name}`;
    case "subagent_start":
      return `spawning ${ev.origin?.path?.[0] ?? "subagent"}`;
    case "subagent_end":
      return "working";
    case "turn_complete":
      return ev.origin ? null : "finishing";
    default:
      return null;
  }
}

// Decorate a dispatcher so every top-level dispatch registers itself and streams its
// current activity into the registry. Transparent otherwise: id/streaming/abort pass
// through, and the caller's own event sink still receives everything.
export function withActivityTracking(
  inner: AgentDispatcher,
  registry: ActivityRegistry,
): AgentDispatcher {
  const wrapped: AgentDispatcher = {
    id: inner.id,
    ...(inner.streaming !== undefined ? { streaming: inner.streaming } : {}),
    async dispatch(args: DispatchArgs): Promise<DispatchResult> {
      if (args.isSubagent) return inner.dispatch(args);
      registry.start({
        conversationId: args.sessionId,
        userId: args.userId,
        agent: args.agentName,
        channel: args.originChannel ?? "internal",
        startedAt: new Date().toISOString(),
        activity: "working",
      });
      const callerSink = args.onEvent;
      const sink: TurnEventSink = (ev) => {
        const label = activityLabel(ev);
        if (label) registry.update(args.sessionId, label);
        callerSink?.(ev);
      };
      try {
        // Always pass the tracking sink: even a buffered channel's turn (no caller sink)
        // gets live activity when the dispatch mode can stream events.
        return await inner.dispatch({ ...args, onEvent: sink });
      } finally {
        registry.end(args.sessionId);
      }
    },
  };
  if (inner.abort) {
    wrapped.abort = (sessionId: string) => inner.abort!(sessionId);
  }
  return wrapped;
}
