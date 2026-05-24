import { Agent } from "undici";
import type { ArtemisConfig } from "../config/schema.js";
import { log } from "../log.js";

// Bypass OneCLI's global MITM dispatcher (same reason as the transcriber): the in-stack
// whisper endpoint is plain HTTP on the private network and needs no credential injection.
const directDispatcher = new Agent();

// If this agent transcribes via the bundled local Whisper container, return the speaches
// model-download URL to POST; otherwise null (external endpoint, or transcription off).
export function whisperProvisionUrl(config: {
  transcribe?: { backend?: string | undefined; baseUrl?: string | undefined; model?: string | undefined } | undefined;
}): string | null {
  const t = config.transcribe;
  if (!t || t.backend !== "openai-whisper" || !t.baseUrl || !t.model) return null;
  if (!t.baseUrl.includes("whisper:8000")) return null; // only the in-stack `whisper` service
  return `${t.baseUrl.replace(/\/$/, "")}/models/${t.model}`;
}

// Ensure the configured model is downloaded into speaches. speaches does NOT auto-download
// on a transcription request — it returns 404 — so we POST the model at supervisor
// startup. This runs on every `dae serve` (so both install and `dae update` provision it),
// and speaches returns 200 immediately when the model is already present, so it's cheap and
// idempotent. Best-effort + logged: a failure here just means transcription 404s until the
// model lands, which the transcriber now logs clearly.
export async function provisionWhisperModel(config: ArtemisConfig): Promise<void> {
  const url = whisperProvisionUrl(config);
  if (!url) return;
  const model = config.transcribe.model;
  log.info({ model }, "ensuring whisper model is downloaded (first run may take a moment)");
  try {
    const res = await fetch(url, {
      method: "POST",
      dispatcher: directDispatcher,
    } as unknown as RequestInit);
    if (res.ok) log.info({ model }, "whisper model ready");
    else log.warn({ model, status: res.status }, "whisper model provision returned non-OK");
  } catch (err) {
    log.warn(
      { model, err: (err as Error).message },
      "whisper model provision failed — transcription will 404 until the model is present",
    );
  }
}
