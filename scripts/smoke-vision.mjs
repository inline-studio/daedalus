// Smoke for vision support:
//  - the OpenAI provider serialises an ImagePart to an image_url data URI;
//  - the kernel's vision policy strips images for a non-vision agent, keeps them for a
//    multimodal one, routes image-bearing turns to a configured vision model, and never
//    re-sends an older image once a newer one has arrived.

import { Kernel } from "../dist/kernel/agent.js";
import { toOpenAIMessages } from "../dist/providers/openai.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const okMsg = { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, stopReason: "end_turn" };
const imgMsg = () => ({
  role: "user",
  content: [
    { type: "text", text: "what is this?" },
    { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } },
  ],
});
const txtMsg = () => ({ role: "user", content: [{ type: "text", text: "hello" }] });
const asstMsg = () => ({ role: "assistant", content: [{ type: "text", text: "a" }] });

function recorder() {
  const seen = { model: null, imageCount: 0 };
  return {
    seen,
    provider: {
      id: "fake",
      capabilities: {},
      async complete(req) {
        seen.model = req.model;
        seen.imageCount = req.messages.reduce(
          (n, m) => n + m.content.filter((c) => c.type === "image").length,
          0,
        );
        return okMsg;
      },
    },
  };
}
function makeKernel(provider, vision) {
  return new Kernel({
    provider,
    model: "main-model",
    system: "s",
    builtinTools: [],
    mcpServers: new Map(),
    toolContext: {},
    maxTurns: 3,
    maxTokens: 100,
    ...(vision !== undefined ? { vision } : {}),
  });
}

// 1. Provider serialises image_url.
{
  const ser = toOpenAIMessages(imgMsg());
  const um = ser.find((m) => m.role === "user");
  const ok =
    um &&
    Array.isArray(um.content) &&
    um.content.some((p) => p.type === "text") &&
    um.content.some((p) => p.type === "image_url" && p.image_url.url === "data:image/png;base64,AAAA");
  expect("provider serialises ImagePart to image_url data URI", !!ok);
}

// 2. No vision (default): images stripped, default model.
{
  const { seen, provider } = recorder();
  await makeKernel(provider).runWithMessages([imgMsg()]);
  expect("vision off strips images", seen.imageCount === 0);
  expect("vision off uses the default model", seen.model === "main-model");
}

// 3. vision:true — image kept, default (multimodal) model.
{
  const { seen, provider } = recorder();
  await makeKernel(provider, true).runWithMessages([imgMsg()]);
  expect("vision:true keeps the image", seen.imageCount === 1);
  expect("vision:true uses the default model", seen.model === "main-model");
}

// 4. vision:"model" — an image-bearing turn routes to the vision model with the image.
{
  const { seen, provider } = recorder();
  await makeKernel(provider, "spark/qwenvl").runWithMessages([imgMsg()]);
  expect("vision model handles the image turn", seen.model === "spark/qwenvl" && seen.imageCount === 1);
}

// 5. vision:"model" — a text-only turn uses the default model, no images.
{
  const { seen, provider } = recorder();
  await makeKernel(provider, "spark/qwenvl").runWithMessages([txtMsg()]);
  expect("text turn stays on the default model", seen.model === "main-model" && seen.imageCount === 0);
}

// 6. Only the most recent image is retained (older one not re-sent).
{
  const { seen, provider } = recorder();
  await makeKernel(provider, true).runWithMessages([imgMsg(), asstMsg(), imgMsg()]);
  expect("older images are dropped, latest kept", seen.imageCount === 1, `count=${seen.imageCount}`);
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
