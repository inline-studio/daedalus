import { bashTool } from "./bash.js";
import { readTool, writeTool, editTool } from "./file.js";
import { webFetchTool, webSearchTool } from "./web.js";
import {
  scheduleMessageTool,
  cancelScheduledMessageTool,
  listScheduledMessagesTool,
} from "./schedule.js";
import type { ToolImpl } from "./base.js";
import type { ArtemisConfig } from "../config/schema.js";
import type { ScheduleStore } from "../sessions/schedule-store.js";

// Tools that don't depend on config get registered as static singletons.
// Tools that need config are factory functions called with the resolved config.
type ToolFactory = (config: ArtemisConfig) => ToolImpl;

const STATIC_TOOLS: Record<string, ToolImpl> = {
  bash: bashTool,
  read: readTool,
  write: writeTool,
  edit: editTool,
};

const FACTORY_TOOLS: Record<string, ToolFactory> = {
  web_fetch: (c) => webFetchTool(c.web),
  web_search: (c) => webSearchTool(c.web),
};

// Tools that need a ScheduleStore (runtime scheduling). The store is opened by
// the agent-turn runner and threaded in alongside config so we can build these
// once per turn rather than re-opening sqlite per invocation.
type ScheduleToolFactory = (store: ScheduleStore) => ToolImpl;
const SCHEDULE_TOOLS: Record<string, ScheduleToolFactory> = {
  schedule_message: scheduleMessageTool,
  cancel_scheduled_message: cancelScheduledMessageTool,
  list_scheduled_messages: listScheduledMessagesTool,
};

export function builtinNames(): string[] {
  return [
    ...Object.keys(STATIC_TOOLS),
    ...Object.keys(FACTORY_TOOLS),
    ...Object.keys(SCHEDULE_TOOLS),
  ];
}

// Strictly per the manifest's `tools:` list. Empty list = no built-in tools.
// (Earlier behaviour was "empty = all" — a security footgun for subagents which
// would otherwise inherit web_fetch / web_search / write / bash by default.)
export function selectBuiltins(
  names: string[],
  config: ArtemisConfig,
  deps: { scheduleStore?: ScheduleStore } = {},
): ToolImpl[] {
  const out: ToolImpl[] = [];
  for (const n of names) {
    if (STATIC_TOOLS[n]) {
      out.push(STATIC_TOOLS[n]);
      continue;
    }
    const f = FACTORY_TOOLS[n];
    if (f) {
      out.push(f(config));
      continue;
    }
    const sf = SCHEDULE_TOOLS[n];
    if (sf) {
      if (!deps.scheduleStore) {
        throw new Error(
          `Tool '${n}' requires a ScheduleStore — the caller didn't pass one. ` +
            `(Internal: pass deps.scheduleStore to selectBuiltins when running an agent turn.)`,
        );
      }
      out.push(sf(deps.scheduleStore));
      continue;
    }
    throw new Error(`Unknown built-in tool: ${n}`);
  }
  return out;
}
