import fs from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { AgentManifestSchema, type AgentManifest } from "../config/schema.js";

export interface LoadedAgent {
  manifest: AgentManifest;
  body: string; // markdown body, used as the agent's own system prompt segment
  sourcePath: string;
}

export async function loadAgent(brainPath: string, agentName: string): Promise<LoadedAgent> {
  const file = path.join(brainPath, "agents", `${agentName}.md`);
  const text = await fs.readFile(file, "utf8");
  const fm = matter(text);
  const manifest = AgentManifestSchema.parse({ ...(fm.data as object), name: agentName });
  return { manifest, body: fm.content.trim(), sourcePath: file };
}

export async function listAgents(brainPath: string): Promise<string[]> {
  const dir = path.join(brainPath, "agents");
  try {
    const files = await fs.readdir(dir);
    return files.filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  } catch {
    return [];
  }
}
