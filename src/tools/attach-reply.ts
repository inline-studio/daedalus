import fs from "node:fs/promises";
import path from "node:path";
import type { ToolImpl } from "./base.js";
import type { AttachmentStore } from "../attachments/store.js";
import type { OutboundAttachment } from "../dispatch/base.js";

// Lets an agent attach a local file (screenshot, PDF, chart, …) to the reply that goes
// back to the user. The file is read, stored in the content-addressable AttachmentStore
// (on the shared /data volume), and recorded in `sink`; the agent-turn returns those
// refs in its DispatchResult, the supervisor resolves them to bytes, and the channel
// uploads them (Telegram sendPhoto/sendDocument, etc.).
//
// Only meaningful for the agent whose reply reaches the user (the top-level turn) — a
// subagent's attachments don't propagate to the channel, so we only register this tool
// for non-subagent turns.
const MAX_BYTES = 10 * 1024 * 1024; // Telegram's photo/doc-friendly ceiling.

export function buildAttachReplyTool(store: AttachmentStore, sink: OutboundAttachment[]): ToolImpl {
  return {
    definition: {
      name: "attach_to_reply",
      description:
        "Attach a local file (screenshot, PDF, image, chart, …) to your reply so the user receives it alongside your text. Pass a path your bash can read — prefer writing the file under $DAE_SHARED first. Max 10 MB. Call once per file.",
      inputSchema: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to attach (must be readable by you; prefer $DAE_SHARED).",
          },
          caption: { type: "string", description: "Optional caption shown with this attachment." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    async invoke(input) {
      const p = String(input.path ?? "").trim();
      if (!p) return { content: "attach_to_reply: 'path' is required", isError: true };

      let data: Buffer;
      try {
        data = await fs.readFile(p);
      } catch (err) {
        return {
          content: `attach_to_reply: cannot read '${p}': ${(err as Error).message}. Write the file under $DAE_SHARED so it's reachable.`,
          isError: true,
        };
      }
      if (data.length === 0) return { content: `attach_to_reply: '${p}' is empty`, isError: true };
      if (data.length > MAX_BYTES) {
        return {
          content: `attach_to_reply: '${p}' is ${data.length} bytes; the limit is ${MAX_BYTES}.`,
          isError: true,
        };
      }

      const filename = path.basename(p);
      const mediaType = mediaTypeForFile(filename);
      const meta = await store.putBuffer(data, mediaType, filename);
      const caption = typeof input.caption === "string" ? input.caption.trim() : "";
      sink.push({
        ref: meta.ref,
        mediaType,
        filename,
        ...(caption ? { caption } : {}),
      });
      return {
        content: `Attached ${filename} (${mediaType}, ${data.length} bytes); it will be sent with your reply.`,
      };
    },
  };
}

// Best-effort media type from the file extension (the bytes are opaque to us).
function mediaTypeForFile(file: string): string {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".pdf":
      return "application/pdf";
    case ".txt":
    case ".log":
      return "text/plain";
    case ".md":
      return "text/markdown";
    case ".csv":
      return "text/csv";
    case ".json":
      return "application/json";
    case ".html":
    case ".htm":
      return "text/html";
    case ".mp4":
      return "video/mp4";
    case ".mp3":
      return "audio/mpeg";
    case ".zip":
      return "application/zip";
    default:
      return "application/octet-stream";
  }
}
