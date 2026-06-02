import type { LLMProvider } from "../providers/base.js";
import type { ConnectedServer } from "../mcp/client.js";
import { callMcpTool } from "../mcp/client.js";
import type { ContentPart, Message } from "../types.js";
import { log } from "../log.js";

// Deterministic memory auto-save: the "curator" that sits in front of the memory backend.
//
// Daedalus runs this after each top-level turn. It distils the turn into a small set of
// durable, atomic facts and writes each to the memory MCP server's add tool. This is
// distinct from (and complementary to) the backend's own ingestion LLM:
//   - THIS stage decides IF and WHAT is worth remembering (salience filter), so the graph
//     isn't flooded with ephemeral task chatter.
//   - Graphiti's ingestion LLM then decides HOW to structure each saved episode into
//     entities, relationships, and temporal edges, and dedupes against what's already there.
//
// Everything here is best-effort and non-fatal: a failure never breaks the user's turn.

export interface ExtractedFact {
  // A short human title for the memory (Graphiti's episode `name`).
  name: string;
  // A single self-contained statement — the durable fact itself (Graphiti's `episode_body`).
  body: string;
}

export interface AutoSaveDeps {
  provider: LLMProvider;
  // Model used for the extraction call, on the agent's provider. Caller resolves the
  // override-vs-agent-model decision; this is the final model string to use.
  model: string;
  // The agent's connected MCP servers. We look for the auto-injected "memory" server.
  mcpServers: Map<string, ConnectedServer>;
  // The messages that make up this turn (the triggering user message + everything the
  // kernel produced). We render a compact transcript of these for the extractor.
  messages: Message[];
  agentName: string;
  // Backstop on how many facts we'll save from a single turn.
  maxFactsPerTurn?: number;
  signal?: AbortSignal;
}

export interface AutoSaveResult {
  // Whether the auto-save path actually ran (vs. skipped because no memory server / no add tool).
  ran: boolean;
  // Facts the extractor proposed.
  considered: number;
  // Facts successfully written to the backend.
  saved: number;
}

const EXTRACTION_SYSTEM = [
  "You are the memory curator for a personal AI assistant. You are shown one turn of",
  "conversation between the user and the assistant. Your job is to extract ONLY durable,",
  "long-term facts worth remembering in future, unrelated conversations.",
  "",
  "SAVE things like:",
  "- Stable facts about the user, their family, home, or business.",
  "- Stated preferences (how they like things done, tools they prefer, tone).",
  "- Decisions made and commitments, with the relevant specifics.",
  "- Important entities and relationships (clients, projects, services, people).",
  "- Concrete outcomes worth recalling later (e.g. a server provisioned and where its",
  "  credentials live, a domain set up, a recurring task agreed).",
  "",
  "DO NOT save:",
  "- Ephemeral chit-chat, greetings, or acknowledgements.",
  "- The assistant's reasoning, intermediate steps, or tool mechanics.",
  "- Transient state that won't matter next week.",
  "- Anything you are not reasonably confident is true and lasting.",
  "",
  "Write each fact as a single self-contained statement in the third person about the user",
  "or their world (so it stands alone with no conversational context). Be specific: keep",
  "names, numbers, URLs, and paths.",
  "",
  'Respond with ONLY a JSON array of objects: [{"name": "<short title>", "body": "<the fact>"}].',
  "If nothing is worth remembering, respond with exactly []. No prose, no code fences.",
].join("\n");

// Render this turn's messages into a compact transcript for the extractor. Tool I/O is
// truncated so a chatty, tool-heavy turn doesn't blow up the extraction call's own context.
export function renderTurnTranscript(messages: Message[], opts?: { maxChars?: number }): string {
  const maxChars = opts?.maxChars ?? 12_000;
  const lines: string[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const rendered = renderContent(m.content);
    if (rendered.trim()) lines.push(`${m.role.toUpperCase()}: ${rendered}`);
  }
  let out = lines.join("\n\n");
  // Keep the most recent content if we're over budget — the tail of a turn carries the
  // outcome (final answer, what was decided), which is what's most worth remembering.
  if (out.length > maxChars) out = "…\n" + out.slice(out.length - maxChars);
  return out;
}

function renderContent(parts: ContentPart[]): string {
  const out: string[] = [];
  for (const p of parts) {
    switch (p.type) {
      case "text":
        out.push(p.text);
        break;
      case "tool_use":
        out.push(`[called ${p.name}(${truncate(JSON.stringify(p.input), 200)})]`);
        break;
      case "tool_result":
        out.push(`[result: ${truncate(p.content, 800)}]`);
        break;
      case "image":
        out.push("[image]");
        break;
      case "audio":
        out.push(p.transcript ? `[audio: ${p.transcript}]` : "[audio]");
        break;
      case "file":
        out.push(`[file ${p.filename}]`);
        break;
    }
  }
  return out.join("\n");
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

// Parse the extractor's reply into facts. Defensive: tolerates code fences and stray prose
// around the JSON array, and drops malformed / empty entries. Returns [] on anything it
// can't make sense of — auto-save must never throw on a model quirk.
export function parseExtractedFacts(raw: string): ExtractedFact[] {
  if (!raw) return [];
  let text = raw.trim();
  // Strip a ```json … ``` (or bare ```) fence if the model added one.
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) text = fence[1].trim();
  // Isolate the outermost array if the model wrapped it in prose.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const facts: ExtractedFact[] = [];
  const seen = new Set<string>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const body = String((item as Record<string, unknown>).body ?? "").trim();
    if (!body) continue;
    const rawName = String((item as Record<string, unknown>).name ?? "").trim();
    const name = rawName || truncate(body, 60);
    const key = body.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ name, body });
  }
  return facts;
}

// Locate the backend's "add a memory" tool by its namespaced name. Graphiti exposes
// `add_memory`; we also accept other add/episode-shaped names so this keeps working if the
// backend changes. Returns the namespaced ("memory__<tool>") name, or null if none matches.
export function findAddMemoryTool(server: ConnectedServer): string | null {
  const names = server.tools.map((t) => t.name);
  const exact = names.find((n) => n === `${server.name}__add_memory`);
  if (exact) return exact;
  const local = (n: string) => n.slice(n.indexOf("__") + 2).toLowerCase();
  const fuzzy = names.find((n) => {
    const l = local(n);
    return l.startsWith("add") && (l.includes("memor") || l.includes("episode") || l.includes("fact"));
  });
  return fuzzy ?? null;
}

export async function autoSaveMemory(deps: AutoSaveDeps): Promise<AutoSaveResult> {
  const skip: AutoSaveResult = { ran: false, considered: 0, saved: 0 };
  const server = deps.mcpServers.get("memory");
  if (!server) return skip;
  const addTool = findAddMemoryTool(server);
  if (!addTool) {
    log.warn(
      { server: "memory", tools: server.tools.map((t) => t.name) },
      "auto-save: memory server connected but no add tool found — skipping",
    );
    return skip;
  }

  const transcript = renderTurnTranscript(deps.messages);
  if (!transcript.trim()) return skip;

  let raw: string;
  try {
    const res = await deps.provider.complete(
      {
        system: EXTRACTION_SYSTEM,
        messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
        tools: [],
        model: deps.model,
        maxTokens: 1024,
        temperature: 0,
      },
      deps.signal,
    );
    raw = res.message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
  } catch (err) {
    log.warn({ err: (err as Error).message }, "auto-save: extraction call failed — nothing saved");
    return { ran: true, considered: 0, saved: 0 };
  }

  let facts = parseExtractedFacts(raw);
  const cap = deps.maxFactsPerTurn ?? 8;
  if (facts.length > cap) {
    log.info({ found: facts.length, cap }, "auto-save: capping extracted facts");
    facts = facts.slice(0, cap);
  }
  if (facts.length === 0) return { ran: true, considered: 0, saved: 0 };

  let saved = 0;
  for (const fact of facts) {
    try {
      const r = await callMcpTool(deps.mcpServers, addTool, {
        name: fact.name,
        episode_body: fact.body,
        source: "text",
        source_description: `auto-saved by daedalus (${deps.agentName})`,
      });
      if (r.isError) {
        log.warn({ name: fact.name, detail: truncate(r.content, 200) }, "auto-save: add tool returned error");
      } else {
        saved++;
      }
    } catch (err) {
      log.warn({ name: fact.name, err: (err as Error).message }, "auto-save: add tool threw");
    }
  }

  log.info({ agent: deps.agentName, considered: facts.length, saved }, "auto-save: wrote memories");
  return { ran: true, considered: facts.length, saved };
}
