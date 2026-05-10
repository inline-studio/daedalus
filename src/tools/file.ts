import fs from "node:fs/promises";
import path from "node:path";
import type { ToolImpl } from "./base.js";

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
    description: "Read a UTF-8 text file. Returns up to 200kb of content.",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  async invoke(input) {
    const p = String(input.path ?? "");
    const text = await fs.readFile(p, "utf8");
    const out = text.length > 200_000 ? text.slice(0, 200_000) + "\n[truncated]" : text;
    return { content: out };
  },
};

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
