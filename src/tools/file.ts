import fs from "node:fs/promises";
import path from "node:path";
import type { ToolImpl } from "./base.js";
import {
  READ_DEFAULT_LINES,
  READ_MAX_LINES,
  READ_MAX_CHARS,
  GLOB_DEFAULT_LIMIT,
  GLOB_MAX_LIMIT,
} from "./limits.js";

// Path safety: writes/edits are blocked against the brain dir unless brainWritable.
function assertWritable(target: string, ctx: { brainPath: string; brainWritable: boolean }): void {
  if (ctx.brainWritable) return;
  const brain = path.resolve(ctx.brainPath);
  const tgt = path.resolve(target);
  if (tgt === brain || tgt.startsWith(brain + path.sep)) {
    throw new Error(
      `Write blocked: '${target}' is inside read-only BRAIN_PATH. Set BRAIN_WRITABLE=1 to allow self-modification.`,
    );
  }
}

export const readTool: ToolImpl = {
  definition: {
    name: "read",
    description:
      `Read a UTF-8 text file. Returns up to ${READ_DEFAULT_LINES} lines from the start by ` +
      "default; pass `offset` (1-based line) and `limit` to page through a larger file. The " +
      "returned slice is also capped at ~60k chars.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        offset: {
          type: "number",
          description: "1-based line number to start from. Default 1.",
        },
        limit: {
          type: "number",
          description: `Max lines to return (1–${READ_MAX_LINES}). Default ${READ_DEFAULT_LINES}.`,
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async invoke(input) {
    const p = String(input.path ?? "");
    const text = await fs.readFile(p, "utf8");
    const lines = text.split("\n");
    const total = lines.length;
    const offset = clampInt(input.offset, 1, Math.max(1, total), 1);
    const limit = clampInt(input.limit, 1, READ_MAX_LINES, READ_DEFAULT_LINES);
    if (offset > total) {
      return { content: `[file has ${total} line(s); offset ${offset} is past the end]` };
    }
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const endLine = offset - 1 + slice.length;
    let out = slice.join("\n");
    if (out.length > READ_MAX_CHARS) {
      // The line range itself is huge (e.g. minified code). Cut hard and tell the agent
      // to narrow — a line-based "continue" offset would be misleading here.
      out =
        out.slice(0, READ_MAX_CHARS) +
        `\n[truncated at ${READ_MAX_CHARS.toLocaleString()} chars — this line range is large; re-read with a smaller limit]`;
    } else if (endLine < total) {
      out += `\n[lines ${offset}-${endLine} of ${total}; pass offset=${endLine + 1} for more]`;
    }
    return { content: out };
  },
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export const writeTool: ToolImpl = {
  definition: {
    name: "write",
    description: "Write a UTF-8 text file (overwrites if it exists). Refuses inside BRAIN_PATH unless BRAIN_WRITABLE=1.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  async invoke(input, ctx) {
    const p = String(input.path ?? "");
    assertWritable(p, ctx);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, String(input.content ?? ""), "utf8");
    return { content: `wrote ${p}` };
  },
};

export const globTool: ToolImpl = {
  definition: {
    name: "glob",
    description:
      "Find files matching a glob pattern. Returns matching paths (sorted), one per line, " +
      "relative to `cwd`. Supports `*` (any chars within a path segment), `**` (any depth), " +
      "`?` (one char), `{a,b}` alternation, and `[abc]` character classes. " +
      `Capped at ${GLOB_DEFAULT_LIMIT.toLocaleString()} matches by default (max ${GLOB_MAX_LIMIT.toLocaleString()}); ` +
      "if you hit the cap, narrow the pattern. Use this to discover files, then `read` to look inside.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern, e.g. '**/*.ts' or 'src/**/{foo,bar}.js'.",
        },
        cwd: {
          type: "string",
          description: "Directory to search from. Defaults to the process working directory.",
        },
        limit: {
          type: "number",
          description: `Max paths to return (1–${GLOB_MAX_LIMIT}). Default ${GLOB_DEFAULT_LIMIT}.`,
        },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  async invoke(input) {
    const pattern = String(input.pattern ?? "").trim();
    if (!pattern) return { content: "glob: 'pattern' is required", isError: true };
    const cwd =
      typeof input.cwd === "string" && input.cwd.trim() ? input.cwd : process.cwd();
    const limit = clampInt(input.limit, 1, GLOB_MAX_LIMIT, GLOB_DEFAULT_LIMIT);
    const matches: string[] = [];
    let hitCap = false;
    try {
      for await (const p of fs.glob(pattern, { cwd })) {
        matches.push(p);
        if (matches.length >= limit) {
          hitCap = true;
          break;
        }
      }
    } catch (err) {
      return { content: `glob failed: ${(err as Error).message}`, isError: true };
    }
    if (matches.length === 0) {
      return { content: `[no matches for '${pattern}' under ${cwd}]` };
    }
    matches.sort();
    const footer = hitCap
      ? `\n[hit limit of ${limit} matches — narrow the pattern]`
      : "";
    return { content: matches.join("\n") + footer };
  },
};

export const editTool: ToolImpl = {
  definition: {
    name: "edit",
    description: "Replace the first occurrence of old_string with new_string in a file. Refuses inside BRAIN_PATH unless BRAIN_WRITABLE=1.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string" },
        old_string: { type: "string" },
        new_string: { type: "string" },
      },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  async invoke(input, ctx) {
    const p = String(input.path ?? "");
    assertWritable(p, ctx);
    const text = await fs.readFile(p, "utf8");
    const oldStr = String(input.old_string ?? "");
    const idx = text.indexOf(oldStr);
    if (idx === -1) return { content: "old_string not found", isError: true };
    const next = text.slice(0, idx) + String(input.new_string ?? "") + text.slice(idx + oldStr.length);
    await fs.writeFile(p, next, "utf8");
    return { content: `edited ${p}` };
  },
};
