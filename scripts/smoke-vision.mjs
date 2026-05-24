// Smoke for vision support (describe-step model):
//  - the OpenAI provider serialises an ImagePart to an image_url data URI;
//  - vision off strips images; vision:true sends the freshest image to the agent's model;
//  - vision:"model" describes the image via a minimal side-call to that vision model (just
//    the image + the user's text, no history, no tools) and the main model handles the
//    turn with the description as text; a failed describe call degrades gracefully.

import { Kernel } from "../dist/kernel/agent.js";
import { toOpenAIMessages } from "../dist/providers/openai.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const okMsg = { message: { role: "assistant", content: [{ type: "text", text: "ok" }] }, stopReason: "end_turn" };
const descMsg = (text) => ({ message: { role: "assistant", content: [{ type: "text", text }] }, stopReason: "end_turn" });
const imgMsg = () => ({
  role: "user",
  content: [
    { type: "text", text: "what is this?" },
    { type: "image", source: { kind: "base64", mediaType: "image/png", data: "AAAA" } },
  ],
});
const txtMsg = () => ({ role: "user", content: [{ type: "text", text: "hello" }] });
const asstMsg = () => ({ role: "assistant", content: [{ type: "text", text: "a" }] });

const isDescribe = (req) => /you are a vision model/i.test(req.system);
const callImages = (req) => req.messages.reduce((n, m) => n + m.content.filter((c) => c.type === "image").length, 0);
const callText = (req) => req.messages.flatMap((m) => m.content.filter((c) => c.type === "text").map((c) => c.text)).join(" ");

// `behavior(req)` may return a CompletionResult or throw; otherwise we default.
function recorder(behavior) {
  const calls = [];
  return {
    calls,
    provider: {
      id: "fake",
      capabilities: {},
      async complete(req) {
        calls.push({
          model: req.model,
          images: callImages(req),
          tools: req.tools.length,
          describe: isDescribe(req),
          messages: req.messages.length,
          text: callText(req),
        });
        return behavior ? behavior(req) : okMsg;
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

// 2. No vision (default): one call, images stripped, default model, no describe.
{
  const { calls, provider } = recorder();
  await makeKernel(provider).runWithMessages([imgMsg()]);
  expect("vision off: single main-model call with no image", calls.length === 1 && calls[0].model === "main-model" && calls[0].images === 0 && !calls[0].describe);
}

// 3. vision:true: one call to the agent's model, image kept, no describe.
{
  const { calls, provider } = recorder();
  await makeKernel(provider, true).runWithMessages([imgMsg()]);
  expect("vision:true: single main-model call WITH the image", calls.length === 1 && calls[0].model === "main-model" && calls[0].images === 1 && !calls[0].describe);
}

// 4. vision:"model": describe via the vision model (image only, no tools/history), then the
//    main model answers with the description spliced in as text.
{
  const { calls, provider } = recorder((req) => (isDescribe(req) ? descMsg("a red apple on a table") : okMsg));
  await makeKernel(provider, "spark/qwenvl").runWithMessages([imgMsg()]);
  expect("two calls: describe then main", calls.length === 2);
  const [d, main] = calls;
  expect(
    "describe call: vision model, image, no tools, just the one message",
    d && d.describe && d.model === "spark/qwenvl" && d.images === 1 && d.tools === 0 && d.messages === 1,
    JSON.stringify(d),
  );
  expect("describe call forwards the user's question", d && /what is this\?/.test(d.text));
  expect(
    "main call: default model, no image, description spliced in as text",
    main && !main.describe && main.model === "main-model" && main.images === 0 && /Image description.*red apple/.test(main.text),
    JSON.stringify(main),
  );
}

// 5. vision:"model" text-only turn: no describe call, single main-model call.
{
  const { calls, provider } = recorder();
  await makeKernel(provider, "spark/qwenvl").runWithMessages([txtMsg()]);
  expect("text turn: single main-model call, no describe", calls.length === 1 && calls[0].model === "main-model" && calls[0].images === 0 && !calls[0].describe);
}

// 6. vision:true keeps only the most recent image (older ones not re-sent).
{
  const { calls, provider } = recorder();
  await makeKernel(provider, true).runWithMessages([imgMsg(), asstMsg(), imgMsg()]);
  expect("only the latest image is retained", calls.length === 1 && calls[0].images === 1, JSON.stringify(calls[0]));
}

// 7. Describe call fails → degrade: main model still answers, with a notice.
{
  const { calls, provider } = recorder((req) => {
    if (isDescribe(req)) throw new Error("401 vision model not configured");
    return okMsg;
  });
  const r = await makeKernel(provider, "spark/qwenvl").runWithMessages([imgMsg()]);
  expect("falls back and still completes", r.finalText === "ok");
  const main = calls.find((c) => !c.describe);
  expect("main model answers without the image", !!main && main.model === "main-model" && main.images === 0);
  expect("surfaces a vision-unavailable notice", Array.isArray(r.notices) && r.notices.some((n) => /couldn.t view the image|vision model is unavailable/i.test(n)), JSON.stringify(r.notices ?? []));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
