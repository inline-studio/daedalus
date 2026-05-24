// Smoke for whisper model auto-provisioning: speaches doesn't auto-download a model
// (transcription 404s otherwise), so the supervisor POSTs it on startup. whisperProvisionUrl
// decides whether/where to provision based on the transcribe config.

import { whisperProvisionUrl } from "../dist/attachments/whisper-provision.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

expect(
  "local whisper → speaches model-download URL",
  whisperProvisionUrl({
    transcribe: { backend: "openai-whisper", baseUrl: "http://whisper:8000/v1", model: "Systran/faster-whisper-small" },
  }) === "http://whisper:8000/v1/models/Systran/faster-whisper-small",
);
expect(
  "external endpoint → null (nothing to provision)",
  whisperProvisionUrl({
    transcribe: { backend: "openai-whisper", baseUrl: "https://api.openai.com/v1", model: "whisper-1" },
  }) === null,
);
expect(
  "transcription off → null",
  whisperProvisionUrl({ transcribe: { backend: "none" } }) === null,
);
expect(
  "no model set → null",
  whisperProvisionUrl({ transcribe: { backend: "openai-whisper", baseUrl: "http://whisper:8000/v1" } }) === null,
);
expect("missing transcribe → null", whisperProvisionUrl({}) === null);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
