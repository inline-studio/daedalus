// Best-effort context-window inference for the web UI's context readout.
//
// Deliberately conservative: only model families whose window is stable, public knowledge
// are listed, and anything unrecognised returns null — the UI then shows a plain token
// count instead of a percentage against a wrong denominator. The per-agent
// `contextWindow:` manifest field always wins (that's the right place for LiteLLM
// aliases, local models, and anything this map doesn't know).

const FAMILY_WINDOWS: Array<{ match: RegExp; window: number }> = [
  // Anthropic Claude models have shipped with a 200k window across Claude 3/4 families.
  { match: /^claude-/i, window: 200_000 },
  // OpenAI gpt-4o family: 128k.
  { match: /^gpt-4o/i, window: 128_000 },
];

export function inferContextWindow(model: string): number | null {
  for (const f of FAMILY_WINDOWS) {
    if (f.match.test(model)) return f.window;
  }
  return null;
}
