// Smoke for resolveAnswersInferred — the non-interactive intent `dae update` derives from
// the existing config so it can re-apply everything (incl. the mempalace→graphiti migration)
// with no prompts. Keys must come back UNDEFINED (already in OneCLI; don't re-register).

import { resolveAnswersInferred } from "../dist/install.js";

let pass = true;
const ok = (label, cond, detail = "") => {
  console.log(`${cond ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!cond) pass = false;
};

// 1. openai + anthropic + local whisper all configured → all inferred on, no keys.
{
  const a = resolveAnswersInferred({
    providers: { openai: { baseUrl: "https://litellm.in-line.studio/v1" }, anthropic: {} },
    transcribe: { backend: "openai-whisper", baseUrl: "http://whisper:8000/v1" },
  });
  ok("useOpenai inferred from providers.openai.baseUrl", a.useOpenai === true);
  ok("openaiBaseUrl carried", a.openaiBaseUrl === "https://litellm.in-line.studio/v1");
  ok("useAnthropic inferred from providers.anthropic", a.useAnthropic === true);
  ok("wantWhisper inferred from transcribe", a.wantWhisper === true);
  ok("no keys leaked (already in OneCLI)", a.openaiKey === undefined && a.anthropicKey === undefined && a.braveKey === undefined);
  ok("no telegram token (kept as-is)", a.telegramToken === undefined);
}

// 2. mempalace-era config (no openai) → openai/whisper off; this is what flips OFF graphiti.
{
  const b = resolveAnswersInferred({ providers: {}, transcribe: { backend: "none" } });
  ok("no openai → useOpenai false", b.useOpenai === false);
  ok("no openai → openaiBaseUrl undefined", b.openaiBaseUrl === undefined);
  ok("no anthropic → useAnthropic false", b.useAnthropic === false);
  ok("no whisper", b.wantWhisper === false);
}

// 3. The casa migration shape: config still says mempalace BUT has an openai endpoint →
//    inferred useOpenai true ⇒ applyDeployment will set memory.backend=graphiti. (We only
//    assert the inference here; the config rewrite is exercised by install/update at runtime.)
{
  const c = resolveAnswersInferred({
    memory: { backend: "mempalace" },
    providers: { openai: { baseUrl: "https://spark/v1" } },
    transcribe: { backend: "none" },
  });
  ok("mempalace+openai → useOpenai true (drives graphiti migration)", c.useOpenai === true);
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
