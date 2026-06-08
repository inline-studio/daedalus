import type { ToolImpl, ToolContext } from "./base.js";
import { ScheduleStore } from "../sessions/schedule-store.js";
import { parseWhen } from "../scheduler/parse-when.js";

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
        `When the schedule fires, the supervisor delivers your 'prompt' as a user-style ` +
        `message to the chosen agent, dispatched the same way a channel message would be. ` +
        `For recurring schedules, the row re-arms automatically after each fire.\n\n` +
        `Returns the schedule id so you can cancel later via cancel_scheduled_message.`,
      inputSchema: {
        type: "object",
        properties: {
          when: {
            type: "string",
            description:
              `When to fire. Accepts: "in N seconds/minutes/hours/days", a future ISO ` +
              `timestamp, or a cron expression (recurring).`,
          },
          prompt: {
            type: "string",
            description: "The prompt text the agent will see when this fires.",
          },
          agent: {
            type: "string",
            description:
              "Which agent to deliver the prompt to. Defaults to the calling agent.",
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
      let parsed;
      try {
        parsed = parseWhen(whenStr);
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
      return {
        content:
          `scheduled ${kind} message id=${row.id} for agent='${agentName}', ` +
          `first fire at ${row.dueAt}.`,
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
        `List the pending and currently-firing schedules this agent has armed. Returns id, ` +
        `agent, next-fire timestamp, and the prompt. Read-only.`,
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
