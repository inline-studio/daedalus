// Caps on how many characters a single tool result may inject into the conversation.
//
// A tool result is part of the transcript: once a tool runs, its output is replayed to
// the model on EVERY subsequent turn until it ages out of the history window. So one
// oversized result — a long web page, a big file, a chatty build log — doesn't cost
// tokens once; it costs them on every following message. These caps bound that blast
// radius. Rough rule of thumb: ~4 characters per token, so 40,000 chars ≈ 10,000 tokens.

export const WEB_FETCH_MAX_CHARS = 40_000; // ≈10k tokens — a fetched page / JSON body
export const BASH_STREAM_MAX_CHARS = 16_000; // ≈4k tokens — applied per stream (stdout, stderr)

// `read` is line-oriented so an agent can page through a large file (offset/limit) instead
// of dumping the whole thing into context on a single call.
export const READ_DEFAULT_LINES = 1_000; // lines returned when `limit` is omitted
export const READ_MAX_LINES = 5_000; // ceiling on an explicit `limit`
export const READ_MAX_CHARS = 60_000; // ≈15k tokens — hard safety cap on the returned slice

// `glob` returns one path per line — typically tens of bytes each, but a runaway pattern
// (`**/*` from /) could otherwise enumerate the universe. Cap matches not characters.
export const GLOB_DEFAULT_LIMIT = 1_000; // matches returned when `limit` is omitted
export const GLOB_MAX_LIMIT = 5_000; // ceiling on an explicit `limit`

// Truncate `s` to `max` characters, appending a short marker when it was cut.
export function capChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n[truncated: output exceeded ${max.toLocaleString()} chars]`;
}
