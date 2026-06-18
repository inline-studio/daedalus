// Stateful splitter for streamed content that carries <think>…</think> reasoning inline — some
// OpenAI-compatible reasoning models emit reasoning this way instead of a separate
// `reasoning_content` field. Because the stream is chunked, a tag can be split across chunk
// boundaries, so we hold back a small tail that might be the start of a tag until we've seen
// enough to decide. Pure and self-contained, so it can be unit-tested without a live stream.
//
// Usage: feed each content chunk to push(); it returns the text and thinking produced so far by
// that chunk. Call end() once the stream finishes to flush whatever remains (an unclosed <think>
// — a truncated reasoning stream — flushes as thinking).
export interface ThinkStreamSplitter {
  push(chunk: string): { textDelta: string; thinkingDelta: string };
  end(): { textDelta: string; thinkingDelta: string };
}

const OPEN = "<think>";
const CLOSE = "</think>";

// Largest k in [1, tag.length-1] such that the end of `s` equals the first k chars of `tag`
// (i.e. `s` might be in the middle of emitting `tag`). 0 if no such overlap.
function partialSuffixLen(s: string, tag: string): number {
  const max = Math.min(s.length, tag.length - 1);
  for (let k = max; k >= 1; k--) {
    if (s.slice(s.length - k) === tag.slice(0, k)) return k;
  }
  return 0;
}

export function createThinkStreamSplitter(): ThinkStreamSplitter {
  let mode: "text" | "think" = "text";
  let buf = "";

  return {
    push(chunk: string) {
      buf += chunk;
      let text = "";
      let think = "";
      for (;;) {
        const tag = mode === "text" ? OPEN : CLOSE;
        const idx = buf.indexOf(tag);
        if (idx !== -1) {
          const before = buf.slice(0, idx);
          if (mode === "text") text += before;
          else think += before;
          buf = buf.slice(idx + tag.length);
          mode = mode === "text" ? "think" : "text";
          continue;
        }
        // No complete tag in the buffer. Emit everything except a trailing run that could be the
        // beginning of the tag we're watching for (held until the next chunk resolves it).
        const keep = partialSuffixLen(buf, tag);
        const emit = buf.slice(0, buf.length - keep);
        if (mode === "text") text += emit;
        else think += emit;
        buf = buf.slice(buf.length - keep);
        break;
      }
      return { textDelta: text, thinkingDelta: think };
    },
    end() {
      const rest = buf;
      buf = "";
      return mode === "text"
        ? { textDelta: rest, thinkingDelta: "" }
        : { textDelta: "", thinkingDelta: rest };
    },
  };
}
