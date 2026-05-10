import type { ToolImpl } from "./base.js";
import type { AttachmentStore } from "../attachments/store.js";

// Built-in tool to let an agent read an attachment by reference. References look like
// "sha256:<hex>" — they appear in the inbound message content after a channel uploads
// an image/audio/file. Returns text directly when the file is text/plain or .md/.txt;
// for other types returns metadata so the agent can decide what to do.
export function readAttachmentTool(store: AttachmentStore): ToolImpl {
  return {
    definition: {
      name: "read_attachment",
      description:
        "Read a stored attachment by its content-addressable reference (e.g. 'sha256:abcd…'). Returns text for text-shaped files; otherwise returns size + mime type.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Attachment reference, format 'sha256:<hex>'." },
          asText: {
            type: "boolean",
            description: "If true, decode bytes as UTF-8 text regardless of mime type.",
            default: false,
          },
        },
        required: ["ref"],
        additionalProperties: false,
      },
    },
    async invoke(input) {
      const ref = String(input.ref ?? "");
      const asText = Boolean(input.asText);
      const buf = await store.readBuffer(ref);
      if (!buf) return { content: `attachment not found: ${ref}`, isError: true };

      if (asText) {
        const text = buf.toString("utf8");
        return { content: text.length > 200_000 ? text.slice(0, 200_000) + "\n[truncated]" : text };
      }

      // Heuristic: small text-shaped buffers get returned directly.
      if (buf.length < 200_000 && looksLikeText(buf)) {
        return { content: buf.toString("utf8") };
      }
      return { content: `binary attachment ${ref}: ${buf.length} bytes` };
    },
  };
}

function looksLikeText(buf: Buffer): boolean {
  // Sample first 1k: reject if any control byte outside whitespace.
  const sample = buf.subarray(0, Math.min(1024, buf.length));
  for (const b of sample) {
    if (b === 0) return false;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) return false;
  }
  return true;
}
