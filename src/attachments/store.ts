import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Content-addressable attachment storage.
//
// Layout: <root>/<sha256-prefix-2>/<sha256>.<ext>
// Reference format: "sha256:<hex>" — opaque to callers; resolve() turns it back into a path.

export interface AttachmentMeta {
  ref: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  filename?: string;
}

export class AttachmentStore {
  constructor(private root: string) {}

  async ensureDir(): Promise<void> {
    await fs.mkdir(this.root, { recursive: true });
  }

  async putBuffer(
    data: Buffer,
    mediaType: string,
    filename?: string,
  ): Promise<AttachmentMeta> {
    await this.ensureDir();
    const sha = crypto.createHash("sha256").update(data).digest("hex");
    const dir = path.join(this.root, sha.slice(0, 2));
    await fs.mkdir(dir, { recursive: true });
    const ext = filename ? path.extname(filename).slice(1) : guessExtension(mediaType);
    const file = path.join(dir, `${sha}${ext ? "." + ext : ""}`);
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, data);
    }
    return {
      ref: `sha256:${sha}`,
      sha256: sha,
      bytes: data.length,
      mediaType,
      ...(filename ? { filename } : {}),
    };
  }

  async resolve(ref: string): Promise<string | null> {
    const m = ref.match(/^sha256:([a-f0-9]{64})$/);
    if (!m) return null;
    const sha = m[1]!;
    const dir = path.join(this.root, sha.slice(0, 2));
    const entries = await fs.readdir(dir).catch(() => [] as string[]);
    const found = entries.find((e) => e.startsWith(sha));
    return found ? path.join(dir, found) : null;
  }

  async readBuffer(ref: string): Promise<Buffer | null> {
    const file = await this.resolve(ref);
    if (!file) return null;
    return fs.readFile(file);
  }
}

function guessExtension(mime: string): string {
  switch (mime) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "audio/mpeg":
      return "mp3";
    case "audio/ogg":
      return "ogg";
    case "audio/wav":
    case "audio/wave":
      return "wav";
    case "audio/webm":
      return "webm";
    case "video/mp4":
      return "mp4";
    case "application/pdf":
      return "pdf";
    case "text/plain":
      return "txt";
    default:
      return "";
  }
}
