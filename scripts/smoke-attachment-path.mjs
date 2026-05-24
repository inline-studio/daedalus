// Smoke for reading document attachments: read_attachment returns inline text for
// text-shaped files, and for binary files (PDFs, etc.) returns the on-disk PATH so the
// agent can hand it to a format-specific skill (e.g. pdf-reader extract <path>).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AttachmentStore } from "../dist/attachments/store.js";
import { readAttachmentTool } from "../dist/tools/attachment.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

const root = path.join(os.tmpdir(), `dae-att-${Date.now()}-${Math.random().toString(36).slice(2)}`);
const store = new AttachmentStore(root);
await store.ensureDir();
const tool = readAttachmentTool(store);

// 1. Binary (PDF-shaped) → returns the on-disk path, and that path really holds the bytes.
{
  const bin = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0x03, 0x00]); // "%PDF" + NULs
  const meta = await store.putBuffer(bin, "application/pdf", "doc.pdf");
  const r = await tool.invoke({ ref: meta.ref }, {});
  expect("binary read reports a path", /saved on disk at:/.test(r.content), r.content.slice(0, 80));
  const m = r.content.match(/saved on disk at:\s*(\S+)/);
  const p = m?.[1];
  expect("the reported path exists and holds the bytes", !!p && fs.existsSync(p) && fs.readFileSync(p).equals(bin), p ?? "(none)");
  expect("path matches store.resolve", p === (await store.resolve(meta.ref)));
}

// 2. Text file → returned inline (unchanged behaviour).
{
  const meta = await store.putBuffer(Buffer.from("hello world"), "text/plain", "a.txt");
  const r = await tool.invoke({ ref: meta.ref }, {});
  expect("text read returns the content inline", r.content === "hello world");
}

// 3. Missing ref → clear error.
{
  const r = await tool.invoke({ ref: "sha256:" + "0".repeat(64) }, {});
  expect("missing attachment → error", r.isError === true && /not found/.test(r.content));
}

fs.rmSync(root, { recursive: true, force: true });

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
