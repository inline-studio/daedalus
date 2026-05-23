// Smoke for outbound reply attachments: the attach_to_reply tool stores a file as a
// content-addressable ref, and the Telegram channel routes text/images/docs to the
// right Bot API methods.

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AttachmentStore } from "../dist/attachments/store.js";
import { buildAttachReplyTool } from "../dist/tools/attach-reply.js";
import { TelegramChannel } from "../dist/channels/telegram.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. attach_to_reply: reads a file, stores it, records a ref in the sink.
{
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "dae-att-"));
  const store = new AttachmentStore(path.join(dir, "store"));
  const png = path.join(dir, "shot.png");
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
  await fs.writeFile(png, bytes);

  const sink = [];
  const tool = buildAttachReplyTool(store, sink);

  const r = await tool.invoke({ path: png, caption: "hi" });
  expect("tool returns non-error", !r.isError, r.content);
  expect("sink got 1 attachment", sink.length === 1, `len=${sink.length}`);
  expect("ref is sha256:<hex>", /^sha256:[a-f0-9]{64}$/.test(sink[0]?.ref ?? ""), sink[0]?.ref);
  expect("mediaType inferred image/png", sink[0]?.mediaType === "image/png", sink[0]?.mediaType);
  expect("filename preserved", sink[0]?.filename === "shot.png", sink[0]?.filename);
  expect("caption preserved", sink[0]?.caption === "hi", sink[0]?.caption);

  const back = await store.readBuffer(sink[0].ref);
  expect("bytes round-trip through the store", back !== null && Buffer.compare(back, bytes) === 0);

  const bad = await tool.invoke({ path: path.join(dir, "nope.png") });
  expect("missing file → isError", bad.isError === true, bad.content);
}

// 2. Telegram send routes text + attachments to the right endpoints.
{
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    req.on("data", () => {});
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const ch = new TelegramChannel({ defaultAgent: "x", token: "test" });
  ch.apiBase = `http://127.0.0.1:${port}`; // override (TS-private; settable at runtime)

  await ch.send("123", {
    text: "hello",
    attachments: [
      { data: Buffer.from("pngbytes"), mediaType: "image/png", filename: "a.png" },
      { data: Buffer.from("pdfbytes"), mediaType: "application/pdf", filename: "b.pdf" },
    ],
  });

  expect("text → /sendMessage", hits.some((u) => u.includes("/sendMessage")), hits.join(","));
  expect("image → /sendPhoto", hits.some((u) => u.includes("/sendPhoto")), hits.join(","));
  expect("pdf → /sendDocument", hits.some((u) => u.includes("/sendDocument")), hits.join(","));

  await new Promise((r) => server.close(r));
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
