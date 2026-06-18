import type { ToolImpl } from "./base.js";
import type { AttachmentIndexStore } from "../attachments/index-store.js";

// Lets the agent rediscover a file the user uploaded in an EARLIER turn or session — or one
// that scrolled out of context — without the user re-sending it. Returns catalogue entries
// (ref + filename + when + summary); the agent then reads the bytes with read_attachment.
// Scoped to the user whose turn is running, so it only ever surfaces their own uploads.
export function findAttachmentTool(store: AttachmentIndexStore, userId: string): ToolImpl {
  return {
    definition: {
      name: "find_attachment",
      description:
        "Find files the user uploaded earlier (in this or a previous conversation) so you can re-reference them WITHOUT asking them to upload again. Search by filename or content keyword; leave 'query' empty to list the most recent uploads. Returns entries with a 'ref' — pass that ref to read_attachment to read the file. Use this whenever the user refers to a document they 'sent before' or 'already shared'.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Filename fragment or content keyword to match. Omit or leave empty to list the most recent uploads.",
          },
          limit: {
            type: "number",
            description: "Maximum number of results (default 20).",
          },
        },
        additionalProperties: false,
      },
    },
    async invoke(input) {
      const query = typeof input.query === "string" ? input.query : "";
      const limit =
        typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : 20;
      const hits = store.search(userId, query, limit);
      if (hits.length === 0) {
        return {
          content: query.trim()
            ? `No uploaded files match "${query}". The user may not have shared it yet — ask them to upload it.`
            : `No files have been uploaded yet.`,
        };
      }
      const lines = hits.map((h) => {
        const name = h.filename ?? "(unnamed)";
        const summary = h.summary ? ` — ${h.summary}` : "";
        return `- ${name} [${h.mediaType}, ${formatBytes(h.bytes)}, uploaded ${h.uploadedAt}] ref ${h.ref}${summary}`;
      });
      return {
        content:
          `${hits.length} file(s) found. Read any of them with read_attachment using its ref:\n` +
          lines.join("\n"),
      };
    },
  };
}

// Lets the agent attach a one-line content summary to a file it has just read, so future
// find_attachment searches match the file by what's IN it, not just its filename. Cheap and
// optional — the catalogue works without it, summaries just make content search better.
export function describeAttachmentTool(store: AttachmentIndexStore, userId: string): ToolImpl {
  return {
    definition: {
      name: "describe_attachment",
      description:
        "Record a one-line description of an uploaded file's contents, so you (or a later session) can find it by topic via find_attachment. Call this after reading a document the user is likely to reference again. The ref is the same 'sha256:…' you read it with.",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "Attachment reference, format 'sha256:<hex>'." },
          summary: {
            type: "string",
            description: "One-line description of what the file contains (≤ ~200 chars).",
          },
        },
        required: ["ref", "summary"],
        additionalProperties: false,
      },
    },
    async invoke(input) {
      const ref = String(input.ref ?? "");
      const summary = String(input.summary ?? "").trim();
      if (!ref) return { content: "describe_attachment: 'ref' is required", isError: true };
      if (!summary) return { content: "describe_attachment: 'summary' is required", isError: true };
      store.setSummary(userId, ref, summary.slice(0, 500));
      return { content: `Noted a description for ${ref}.` };
    },
  };
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
