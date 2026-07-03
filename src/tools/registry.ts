import { bashTool } from "./bash.js";
import { readTool, writeTool, editTool, globTool } from "./file.js";
import { webFetchTool, webSearchTool } from "./web.js";
import { buildSkillManageTool } from "./skill-manage.js";
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
  glob: globTool,
};

const FACTORY_TOOLS: Record<string, ToolFactory> = {
  web_fetch: (c) => webFetchTool(c.web),
  web_search: (c) => webSearchTool(c.web),
};

// Explicit-opt-in tools: resolvable by NAME but excluded from the '*' wildcard (and from
// builtinNames). skill_manage rewrites the brain — an agent gets it only by naming it in
// `tools:` (or via the skill-review pass, which builds it directly); a subagent that was
// handed wildcard tools must not silently inherit the ability to edit its own skills.
const EXPLICIT_ONLY_TOOLS: Record<string, ToolFactory> = {
  skill_manage: (c) => buildSkillManageTool(c),
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

// Strictly per the manifest's `tools:` list. Three shapes:
//   tools: []     — no built-in tools (default; what subagents typically want)
//   tools: ['*']  — every built-in tool (the explicit "give me everything"
//                   opt-in; recommended for the orchestrator)
//   tools: [...]  — that exact subset
// Empty was previously "all" — that was a security footgun for subagents which
// would otherwise inherit web_fetch / web_search / write / bash by default.
// The wildcard restores the convenience without the silent surprise.
export function selectBuiltins(
  names: string[],
  config: ArtemisConfig,
  deps: { scheduleStore?: ScheduleStore } = {},
): ToolImpl[] {
  const isWildcard = names.includes("*");
  // The wildcard never includes explicit-only tools (skill_manage — brain-write powers a
  // wildcard subagent must not silently inherit), but naming one NEXT to the wildcard is
  // a deliberate grant: `tools: ['*', 'skill_manage']` = everything plus that opt-in.
  const resolved = isWildcard
    ? [...builtinNames(), ...names.filter((n) => n !== "*" && EXPLICIT_ONLY_TOOLS[n])]
    : names;
  const out: ToolImpl[] = [];
  for (const n of resolved) {
    if (STATIC_TOOLS[n]) {
      out.push(STATIC_TOOLS[n]);
      continue;
    }
    const f = FACTORY_TOOLS[n] ?? EXPLICIT_ONLY_TOOLS[n];
    if (f) {
      out.push(f(config));
      continue;
    }
    const sf = SCHEDULE_TOOLS[n];
    if (sf) {
      if (!deps.scheduleStore) {
        // Two cases:
        //  - Explicit named selection ("tools: ['schedule_message']") with no
        //    store → wrong call site; throw so the caller knows to plumb it.
        //  - Wildcard ("tools: ['*']") with no store (e.g. a one-shot caller that
        //    doesn't open a ScheduleStore) → skip the tool silently; wildcard
        //    semantics are "give me what's available."
        if (isWildcard) continue;
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
