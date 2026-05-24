import type { ContentPart, Message } from "../types.js";
import { startsMidExchange } from "./agent.js";

// Rough token estimate for a message's content. We don't ship a tokenizer, so use the
// common ~4-chars-per-token heuristic over the text-bearing fields. Slightly OVER-
// estimating is fine here — it just makes the budget trim a touch more conservatively.
export function estimateTokens(content: ContentPart[]): number {
  let chars = 0;
  for (const p of content) {
    switch (p.type) {
      case "text":
        chars += p.text.length;
        break;
      case "tool_use":
        chars += p.name.length + JSON.stringify(p.input).length;
        break;
      case "tool_result":
        chars += p.content.length;
        break;
      case "image":
        // Providers either drop base64 images or send them as bounded vision tokens, so
        // count a flat, conservative amount rather than the (enormous) base64 length.
        chars += 6_000; // ≈1.5k tokens
        break;
      case "audio":
        // Raw audio isn't sent on the wire; only the transcript (if any) is.
        chars += p.transcript?.length ?? 0;
        break;
      case "file":
        chars += (p.excerpt?.length ?? 0) + 200;
        break;
    }
  }
  return Math.ceil(chars / 4);
}

// Trim a message list (oldest-first) so the replayed history fits within `maxTokens`.
// Always keeps the most recent message (the turn's trigger), extends backward while the
// budget allows, and never returns a window that opens mid-exchange (a bare tool_result,
// or an assistant turn) — providers reject those.
//
// This is the PROACTIVE counterpart to the kernel's reactive on-overflow trim: by keeping
// the starting payload lean, most turns never reach the retry path. It also means a high
// `historyLimit` (or an old session full of pre-cap, oversized messages) can't blow the
// window — the budget trims it regardless of message count.
export function budgetTail(messages: Message[], maxTokens: number): Message[] {
  if (messages.length <= 1) return messages;
  let total = estimateTokens(messages[messages.length - 1]!.content);
  let startIdx = messages.length - 1;
  for (let i = messages.length - 2; i >= 0; i--) {
    const t = estimateTokens(messages[i]!.content);
    if (total + t > maxTokens) break;
    total += t;
    startIdx = i;
  }
  let out = messages.slice(startIdx);
  while (out.length > 1 && startsMidExchange(out[0]!)) out = out.slice(1);
  return out;
}
