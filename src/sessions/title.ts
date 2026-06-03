import type { LLMProvider } from "../providers/base.js";
import type { Message } from "../types.js";
import { renderTurnTranscript } from "../memory/auto-save.js";
import { log } from "../log.js";

// Model-generated conversation titles for the web UI's separate-conversations sidebar.
//
// The web channel shows a list of conversations; a brand-new one starts with a provisional
// title (the first ~50 chars of the first message) which is a poor label when the message
// doesn't open with anything name-worthy. After the first exchange we ask the model for a
// short, topical title and replace the provisional one. Best-effort: any failure leaves the
// provisional title in place and never affects the user's reply.

const TITLE_SYSTEM = [
  "You name chat conversations. You are shown the first exchange of a conversation between a",
  "user and an assistant. Produce a SHORT, specific title describing what the conversation is",
  "about — like a chat history label.",
  "",
  "Rules:",
  "- 3 to 6 words. Hard max 6 words.",
  "- No surrounding quotes, no trailing punctuation, no emoji, no markdown.",
  "- Describe the topic, not the assistant's actions (e.g. 'Refactor the auth module', not",
  "  'Assistant helps with code').",
  "- Use the conversation's own language.",
  "",
  "Respond with ONLY the title text — nothing else.",
].join("\n");

export interface TitleDeps {
  provider: LLMProvider;
  // The model to use for the (tiny) title call — the agent's own model.
  model: string;
  // The first-exchange messages (triggering user message + the assistant's reply).
  messages: Message[];
  signal?: AbortSignal;
}

// Clean a raw model response into a usable title: strip code fences / wrapping quotes, collapse
// whitespace to a single line, drop trailing punctuation, and cap the length. Returns "" if
// there's nothing usable (caller then leaves the existing title untouched).
export function cleanTitle(raw: string): string {
  let t = (raw ?? "").trim();
  if (!t) return "";
  // Strip a ``` fence if the model wrapped it.
  const fence = t.match(/^```(?:[a-z]*)?\s*([\s\S]*?)\s*```$/i);
  if (fence?.[1]) t = fence[1].trim();
  // Take the first non-empty line only.
  t = t.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  // Strip matching wrapping quotes (straight or curly).
  t = t.replace(/^["'“”‘’]+/, "").replace(/["'“”‘’]+$/, "").trim();
  t = t.replace(/\s+/g, " ").trim();
  // Drop a trailing period/comma/colon a model sometimes adds.
  t = t.replace(/[.,:;]+$/, "").trim();
  if (!t) return "";
  return t.length > 60 ? t.slice(0, 59).trimEnd() + "…" : t;
}

// Ask the model for a short title for a conversation. Returns null on any failure or if the
// transcript is empty, so the caller keeps whatever title is already set.
export async function generateConversationTitle(deps: TitleDeps): Promise<string | null> {
  const transcript = renderTurnTranscript(deps.messages, { maxChars: 4000 });
  if (!transcript.trim()) return null;
  try {
    const res = await deps.provider.complete(
      {
        system: TITLE_SYSTEM,
        messages: [{ role: "user", content: [{ type: "text", text: transcript }] }],
        tools: [],
        model: deps.model,
        maxTokens: 24,
        temperature: 0.3,
      },
      deps.signal,
    );
    const raw = res.message.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    const title = cleanTitle(raw);
    return title || null;
  } catch (err) {
    log.warn({ err: (err as Error).message }, "conversation-title: generation failed (ignored)");
    return null;
  }
}
