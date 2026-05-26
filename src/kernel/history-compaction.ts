import type { Message, ContentPart } from "../types.js";

// When an agent finishes a turn-loop (the agent emits a final text-only assistant message,
// no more tool_use), the trial-and-error that led to it has ALREADY been distilled into that
// final text — so the bulky tool_result bodies in the chain leading up to it are now
// redundant. We can strip them at REPLAY time (we don't mutate the persisted session — the
// dump and DB stay full-fidelity) to keep the per-turn prompt small.
//
// This is the proactive counterpart to the kernel's reactive overflow-compaction (which
// fires late, with an LLM summary call). This one is deterministic, cheap (no LLM), and
// fires every turn — and on top of `contextTokenBudget`'s blunt oldest-first trim, it
// targets exactly the heaviest parts (long tool_results) without losing the loop's outcome
// (the agent's own final text + the tool_use headers stay).
//
// Configurable: keep the N most recent turn-loops at full fidelity (default 2 — current
// loop + previous, so a follow-up like "what was that 5th droplet's IP?" still works).
// Set to 0 to disable.

export interface CompactOpts {
  /** How many recent completed turn-loops to keep at full fidelity. */
  keepFullFidelityLoops: number;
}

// A "user text message" — i.e. the user's actual input, not a synthetic tool_result envelope.
// Each one starts a new turn-loop in our model (everything until the next user-text message
// belongs to that loop: assistant tool_use, user tool_result, …, final assistant text).
function isUserTextMessage(m: Message): boolean {
  if (m.role !== "user") return false;
  if (m.content.some((p) => p.type === "tool_result")) return false;
  return m.content.some((p) => p.type === "text");
}

// Replace the content of every tool_result part with a short stub. Keeps the part shape
// (toolUseId, isError) so the conversation structure is intact — only the bulky body is
// dropped. Returns a NEW message; never mutates the input.
function stubToolResults(m: Message): Message {
  let touched = false;
  const next: ContentPart[] = m.content.map((p) => {
    if (p.type !== "tool_result") return p;
    const origLen = p.content.length;
    if (origLen === 0) return p; // nothing to compact
    touched = true;
    const stub = `[tool_result: ${origLen} chars, omitted post-completion — see assistant summary]`;
    return { ...p, content: stub };
  });
  return touched ? { ...m, content: next } : m;
}

// Return a NEW messages array where all but the most recent `keepFullFidelityLoops`
// turn-loops have their tool_result bodies replaced with short stubs. tool_use parts are
// preserved (small, useful for "what did I try"). The persisted history is untouched —
// this is purely a view transformation applied at replay time.
export function compactCompletedLoops(messages: Message[], opts: CompactOpts): Message[] {
  if (opts.keepFullFidelityLoops <= 0 || messages.length === 0) return messages;

  // Indices of every "user text" message (loop boundaries).
  const boundaries: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (isUserTextMessage(messages[i]!)) boundaries.push(i);
  }
  // If we have <= K loops, nothing to compact.
  if (boundaries.length <= opts.keepFullFidelityLoops) return messages;

  // Everything from the K-th most recent user-text message onward stays full fidelity.
  const cutoff = boundaries[boundaries.length - opts.keepFullFidelityLoops]!;
  return messages.map((m, i) => (i < cutoff ? stubToolResults(m) : m));
}
