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

// One step of a turn's inner life ("thinking — what's the best approach…",
// "tool: web_fetch — php.net"). `key` groups a run of related updates (e.g. one
// thinking segment) so streaming deltas refine the entry in place instead of
// flooding the log with near-duplicates.
export interface ActivityLogEntry {
  at: string; // ISO
  label: string;
  key?: string;
}

// Rolling cap per turn. Long turns keep the newest steps; the log is a live view,
// not an audit trail (the conversation transcript has the full detail).
const LOG_CAP = 100;

export interface ActiveTurn {
  conversationId: string;
  userId: string;
  agent: string;
  channel: string;
  startedAt: string; // ISO
  // Human-readable "what it's doing right now": thinking / replying / tool: bash /
  // cypher › bash / finishing. Coarse by design — the conversation has the detail.
  activity: string;
  // The flowing step-by-step feed behind `activity` — what the agent has been doing
  // this turn, newest last. Powers the Agents · Activity modal's detail pane.
  log: ActivityLogEntry[];
}

export class ActivityRegistry {
  private turns = new Map<string, ActiveTurn>(); // keyed by sessionId (one top-level turn at a time)

  start(t: ActiveTurn | (Omit<ActiveTurn, "log"> & { log?: ActivityLogEntry[] })): void {
    this.turns.set(t.conversationId, { ...t, log: t.log ?? [] });
  }

  update(conversationId: string, activity: string, coalesceKey?: string): void {
    const t = this.turns.get(conversationId);
    if (!t) return;
    t.activity = activity;
    const last = t.log[t.log.length - 1];
    // Same coalesce key as the latest entry → the label is a refinement of the same
    // step (a thinking snippet growing token by token); update it in place.
    if (last && coalesceKey && last.key === coalesceKey) {
      last.label = activity;
      return;
    }
    if (last && last.label === activity) return; // exact repeat — nothing new to say
    t.log.push({ at: new Date().toISOString(), label: activity, ...(coalesceKey ? { key: coalesceKey } : {}) });
    if (t.log.length > LOG_CAP) t.log.splice(0, t.log.length - LOG_CAP);
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

// A one-line summary of a tool call's most telling input field — "web_fetch — php.net"
// says far more than "web_fetch". Field priority covers the built-in tools; unknown
// tools fall back to their first short string value.
const TELLING_FIELDS = ["command", "cmd", "url", "path", "file_path", "pattern", "query", "name", "prompt"];
export function describeToolInput(input: Record<string, unknown>): string | null {
  const fields = [...TELLING_FIELDS, ...Object.keys(input)];
  for (const f of fields) {
    const v = input[f];
    if (typeof v === "string" && v.trim()) {
      const s = v.trim().replace(/\s+/g, " ");
      return s.length > 70 ? s.slice(0, 69) + "…" : s;
    }
  }
  return null;
}

// Trailing snippet of an in-progress thinking segment, kept short enough to read as a
// live label ("thinking — …the simplest fix is to gate the re-apply on").
function thinkingSnippet(buf: string): string {
  const s = buf.replace(/\s+/g, " ").trim();
  return s.length > 90 ? "…" + s.slice(-89) : s;
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
    case "tool_use": {
      const detail = describeToolInput(ev.input);
      return prefix + `tool: ${ev.name}` + (detail ? ` — ${detail}` : "");
    }
    // tool_running always follows a tool_use that already announced the call (with its
    // input detail) — repeating a bare "tool: name" here would only clutter the log.
    case "tool_running":
      return null;
    case "tool_result":
      return ev.isError ? prefix + `tool failed: ${ev.name}` : null;
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
        log: [],
      });
      const callerSink = args.onEvent;
      // Thinking streams token-by-token; accumulate the current segment so the log shows
      // WHAT it's thinking about, coalesced into one refining entry per segment.
      let thinkingBuf = "";
      let thinkingSeq = 0;
      const sink: TurnEventSink = (ev) => {
        if (ev.type === "thinking_delta") {
          thinkingBuf += ev.text;
          const prefix = ev.origin?.path?.length ? ev.origin.path.join(" › ") + " · " : "";
          const snip = thinkingSnippet(thinkingBuf);
          registry.update(
            args.sessionId,
            prefix + "thinking" + (snip ? " — " + snip : ""),
            `think:${prefix}:${thinkingSeq}`,
          );
        } else {
          if (thinkingBuf) {
            thinkingBuf = "";
            thinkingSeq++; // the next thinking segment is a new log entry
          }
          const label = activityLabel(ev);
          if (label) registry.update(args.sessionId, label, ev.type === "text_delta" ? "reply" : undefined);
        }
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
