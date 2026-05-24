// Smoke for whisper compose-profile detection: `dae update` must keep the in-stack
// whisper container active across rebuilds. localWhisperEnabled() decides whether the
// `whisper` compose profile should be activated, based on the transcribe config.

import { localWhisperEnabled } from "../dist/install.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

expect(
  "local whisper container → profile active",
  localWhisperEnabled({ transcribe: { backend: "openai-whisper", baseUrl: "http://whisper:8000/v1" } }) === true,
);
expect(
  "external whisper endpoint → no profile (no container to start)",
  localWhisperEnabled({ transcribe: { backend: "openai-whisper", baseUrl: "https://api.openai.com/v1" } }) === false,
);
expect(
  "transcription off → no profile",
  localWhisperEnabled({ transcribe: { backend: "none" } }) === false,
);
expect("missing transcribe block → no profile", localWhisperEnabled({}) === false);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
