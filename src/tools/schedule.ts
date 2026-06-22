import type { ToolImpl, ToolContext } from "./base.js";
import { ScheduleStore } from "../sessions/schedule-store.js";
import { parseWhen } from "../scheduler/parse-when.js";
import { canPushAsync } from "../channels/delivery.js";
import { loadAgent, listAgents } from "../brain/agents.js";

// SEC-06: an agent may schedule a turn only for itself or for an agent it is allowed to
// spawn (its manifest `subagents`, with `*` meaning every agent). This mirrors the
// spawn_subagent trust edge exactly, so scheduling grants no reach the caller doesn't
// already have synchronously. Pure + exported so the policy is unit-testable without a
// brain on disk.
export function scheduleTargetAllowed(
  callerName: string,
  target: string,
  callerSubagents: string[],
  allAgents: string[],
): boolean {
  if (target === callerName) return true; // self-scheduling (reminders) is always allowed
  const spawnable = callerSubagents.includes("*")
    ? allAgents.filter((n) => n !== callerName)
    : callerSubagents;
  return spawnable.includes(target);
}

// Built-in tools that let an agent arm runtime callbacks: a one-shot reminder,
// a recurring poll ("update me every 10 minutes"), or cancel/list its own.
//
// Scoping: rows are tagged with the calling agent's name (ctx.agentName). cancel
// and list are scoped to that creator, so subagents can't reach into a sibling's
// schedules. The agent that fires (the row's `agent_name`) is independent — by
// default it's the calling agent, but the orchestrator can schedule a different
// agent to be the fire target ("ask cypher in an hour how the build's going").
//
// The store is opened by the agent-turn runner and passed via ToolContext.
export function scheduleMessageTool(store: ScheduleStore): ToolImpl {
  return {
    definition: {
      name: "schedule_message",
      description:
        `Arm a future message that will be delivered to an agent. Use this for:\n` +
        `  - reminders ("in 30 minutes")\n` +
        `  - recurring status pings ("*/10 * * * *")\n` +
        `  - deferred handoffs ("at 2026-05-18T15:00:00Z")\n\n` +
        `When the schedule fires, the supervisor delivers your 'prompt' to the chosen agent ` +
        `as a turn, dispatched the same way a channel message would be. The fired turn is ` +
        `tagged so the agent knows it's a timer firing (not a fresh user request) and acts ` +
        `on it directly — it will not re-schedule or ask about rescheduling.\n` +
        `For recurring schedules, the row re-arms automatically after each fire.\n\n` +
        `Returns the schedule id so you can cancel later via cancel_scheduled_message.`,
      inputSchema: {
        type: "object",
        properties: {
          when: {
            type: "string",
            description:
              `When to fire. Accepts: "in N seconds/minutes/hours/days", a future ISO ` +
              `timestamp, or a cron expression (recurring). IMPORTANT: cron fields are ` +
              `interpreted in your LOCAL timezone (the one shown in your "# Now" context), ` +
              `NOT UTC. "0 7 * * *" means 07:00 local. The result echoes the first fire in ` +
              `both local time and UTC — check it matches what you intended.`,
          },
          prompt: {
            type: "string",
            description:
              `The instruction your future self will act on when this fires. Write it as a ` +
              `forward instruction, NEVER as the user's own words. Reminder: "Remind the ` +
              `user to log their travel expenses" — not "remind me to log expenses". ` +
              `Self-task: "Check Cypher's progress on <task> and update the user".`,
          },
          agent: {
            type: "string",
            description:
              "Which agent to deliver the prompt to. Defaults to the calling agent. You may " +
              "only target yourself or one of your own subagents.",
          },
        },
        required: ["when", "prompt"],
        additionalProperties: false,
      },
    },
    async invoke(input, ctx: ToolContext) {
      const whenStr = String(input.when ?? "");
      const prompt = String(input.prompt ?? "");
      const agentName = (input.agent as string | undefined) ?? ctx.agentName;
      if (!prompt.trim()) {
        return { content: "schedule_message: prompt is required", isError: true };
      }
      // SEC-06: authorize the target. An agent may schedule only itself or an agent it could
      // spawn (its subagents). Fail closed if the caller's manifest can't be loaded.
      if (agentName !== ctx.agentName) {
        let callerSubagents: string[] = [];
        let allAgents: string[] = [];
        try {
          callerSubagents = (await loadAgent(ctx.brainPath, ctx.agentName)).manifest.subagents;
          if (callerSubagents.includes("*")) allAgents = await listAgents(ctx.brainPath);
        } catch {
          callerSubagents = []; // can't verify delegation rights → deny cross-agent target
        }
        if (!scheduleTargetAllowed(ctx.agentName, agentName, callerSubagents, allAgents)) {
          return {
            content:
              `schedule_message: not permitted to schedule agent '${agentName}'. You may only ` +
              `schedule yourself or one of your own subagents` +
              (callerSubagents.length && !callerSubagents.includes("*")
                ? ` (${callerSubagents.join(", ")})`
                : "") +
              `.`,
            isError: true,
          };
        }
      }
      // Evaluate cron in the agent's local zone (the supervisor pins TZ to the configured
      // timezone, which Intl resolves here) so wall-clock cron means what the agent intends
      // and the result can echo local time — closing the "0 6 meant 06:00 UTC" trap.
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      let parsed;
      try {
        parsed = parseWhen(whenStr, new Date(), tz);
      } catch (err) {
        return { content: (err as Error).message, isError: true };
      }
      // The fire must route back to the user who armed it. Without a known origin
      // (channel + external id) the schedule would land in an orphan session — the
      // exact bug this guard prevents — so refuse rather than silently misroute.
      if (!ctx.originChannel || !ctx.originExternalUserId) {
        return {
          content:
            "schedule_message: can't determine which user to deliver to (no origin channel). " +
            "This turn has no originating channel identity to route the reminder back to.",
          isError: true,
        };
      }
      const row = store.enqueue({
        agentName,
        createdByAgent: ctx.agentName,
        channel: ctx.originChannel,
        userExternalId: ctx.originExternalUserId,
        prompt,
        dueAt: parsed.dueAt,
        recurringCron: parsed.cron ?? null,
      });
      const kind = parsed.cron ? `recurring (cron='${parsed.cron}')` : "one-shot";
      const localFire = formatLocal(row.dueAt, tz);
      // Warn (don't block) when the delivery channel can't push: the fire will run but the user
      // won't be alerted unless they're actively connected — so the agent can tell them to expect
      // it in that surface, or re-arm somewhere push-capable.
      const pushWarning = canPushAsync(ctx.originChannel)
        ? ""
        : `\n\n⚠️ This is armed on the '${ctx.originChannel}' channel, which can't push ` +
          `notifications. When it fires the message is written to the conversation but the user ` +
          `is NOT alerted unless they have ${ctx.originChannel} open. For a reliable scheduled ` +
          `delivery (e.g. a daily briefing), arm it from a push channel such as Telegram.`;
      return {
        content:
          `scheduled ${kind} message id=${row.id} for agent='${agentName}', ` +
          `first fire at ${localFire} (${tz}) = ${row.dueAt}.${pushWarning}`,
      };
    },
  };
}

export function cancelScheduledMessageTool(store: ScheduleStore): ToolImpl {
  return {
    definition: {
      name: "cancel_scheduled_message",
      description:
        `Cancel a pending or recurring scheduled message that this agent armed. ` +
        `Only your own schedules can be cancelled — subagents can't reach each other's.`,
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Schedule id (sched_…) from schedule_message." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
    async invoke(input, ctx: ToolContext) {
      const id = String(input.id ?? "");
      const ok = store.cancel(id, ctx.agentName);
      return ok
        ? { content: `cancelled ${id}` }
        : { content: `no active schedule ${id} found for this agent (already done, cancelled, or not yours)`, isError: true };
    },
  };
}

export function listScheduledMessagesTool(store: ScheduleStore): ToolImpl {
  return {
    definition: {
      name: "list_scheduled_messages",
      description:
        `List the pending schedules this agent has armed. Returns id, agent, next-fire ` +
        `timestamp, and the prompt. Read-only.`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    async invoke(_input, ctx: ToolContext) {
      const rows = store.listForAgent(ctx.agentName);
      if (rows.length === 0) return { content: "(no active schedules)" };
      const lines = rows.map(
        (r) =>
          `${r.id}\t${r.agentName}\t${r.dueAt}${r.recurringCron ? `\t(cron: ${r.recurringCron})` : ""}\t${truncate(r.prompt, 80)}`,
      );
      return { content: lines.join("\n") };
    },
  };
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// Render a UTC ISO instant as wall-clock time in the given IANA zone, so the agent sees the
// local hour it actually scheduled (e.g. "2026-06-21 07:00" for "0 7 * * *" in Europe/London)
// alongside the UTC instant. Falls back to the raw ISO if the zone is unusable.
function formatLocal(iso: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
