import { bashTool } from "./bash.js";
import { readTool, writeTool, editTool } from "./file.js";
import { webFetchTool, webSearchTool } from "./web.js";
import type { ToolImpl } from "./base.js";
import type { ArtemisConfig } from "../config/schema.js";

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

export function builtinNames(): string[] {
  return [...Object.keys(STATIC_TOOLS), ...Object.keys(FACTORY_TOOLS)];
}

export function selectBuiltins(names: string[], config: ArtemisConfig): ToolImpl[] {
  const wanted = names.length === 0 ? builtinNames() : names;
  const out: ToolImpl[] = [];
  for (const n of wanted) {
    if (STATIC_TOOLS[n]) {
      out.push(STATIC_TOOLS[n]);
      continue;
    }
    const f = FACTORY_TOOLS[n];
    if (!f) throw new Error(`Unknown built-in tool: ${n}`);
    out.push(f(config));
  }
  return out;
}
