import { Agent } from "undici";

// Speech-to-text interface. Implementations:
//   - WhisperLocalTranscriber: shells out to a whisper.cpp / faster-whisper binary
//   - OpenAITranscriber: POST /v1/audio/transcriptions
//   - NoopTranscriber: returns null (audio is passed through untranscribed)
//
// Channel adapters call transcribe() before publishing audio messages so the kernel
// can inject the transcript as text alongside (or instead of) the audio part.

// Transcription must bypass the global undici dispatcher. When OneCLI installs its
// MITM ProxyAgent via setGlobalDispatcher, routing the whisper request through it
// corrupts the response — undici throws "Response does not match the HTTP/1.1
// protocol". The whisper endpoint is the in-stack container (or an explicit URL) and
// carries its own auth header; it never needs OneCLI's credential injection. Same
// fix as the MCP client (src/mcp/client.ts).
const transcriberDirectDispatcher = new Agent();

export interface Transcriber {
  readonly id: string;
  transcribe(audio: Buffer, mediaType: string): Promise<string | null>;
}

export class NoopTranscriber implements Transcriber {
  readonly id = "noop";
  async transcribe(): Promise<string | null> {
    return null;
  }
}

// Lightweight wrapper around the OpenAI Whisper endpoint. Compatible with any
// OpenAI-shaped /audio/transcriptions endpoint (e.g., a self-hosted whisper.cpp server).
export class OpenAITranscriber implements Transcriber {
  readonly id = "openai-whisper";

  constructor(
    private opts: {
      apiKey: string;
      baseUrl?: string;
      model?: string;
    },
  ) {}

  async transcribe(audio: Buffer, mediaType: string): Promise<string | null> {
    // baseUrl convention matches the openai provider: it must include the /v1 suffix
    // (e.g. "https://api.openai.com/v1", "http://localhost:8000/v1"). If unset, fall back
    // to OpenAI's canonical base. We just append the path past /v1.
    const root = (this.opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const url = `${root}/audio/transcriptions`;
    const form = new FormData();
    form.set("file", new Blob([audio], { type: mediaType }), `audio.${mediaType.split("/")[1] ?? "bin"}`);
    form.set("model", this.opts.model ?? "whisper-1");

    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      // bypass the OneCLI MITM proxy (see note above)
      dispatcher: transcriberDirectDispatcher,
    } as unknown as RequestInit);
    if (!res.ok) return null;
    const json = (await res.json()) as { text?: string };
    return json.text ?? null;
  }
}
