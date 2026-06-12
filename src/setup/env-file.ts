import fs from "node:fs/promises";
import { atomicWrite } from "./atomic-write.js";

// Minimal .env writer that preserves unrelated keys and comments.
// Format: KEY=value, one per line. Quotes are added if value contains spaces or special chars.

export async function upsertEnvFile(filePath: string, updates: Record<string, string>): Promise<void> {
  let lines: string[] = [];
  try {
    const text = await fs.readFile(filePath, "utf8");
    lines = text.split(/\r?\n/);
  } catch {
    // file may not exist yet
  }

  const handled = new Set<string>();
  const out: string[] = [];

  for (const line of lines) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1]!)) {
      handled.add(m[1]!);
      out.push(`${m[1]}=${quoteValue(updates[m[1]!]!)}`);
    } else {
      out.push(line);
    }
  }

  // Append any new keys
  for (const [k, v] of Object.entries(updates)) {
    if (!handled.has(k)) {
      if (out.length > 0 && out[out.length - 1] !== "") out.push("");
      out.push(`${k}=${quoteValue(v)}`);
    }
  }

  // Trim trailing empties to one
  while (out.length > 1 && out[out.length - 1] === "" && out[out.length - 2] === "") out.pop();

  const body = out.join("\n") + (out.length && out[out.length - 1] !== "" ? "\n" : "");
  // SEC-08: this file holds secrets (.env.local, compose .env) — write it owner-only (0600).
  // IMP-04: atomically (temp + rename) so an interrupted write can't truncate it / lose secrets.
  // Safe at 0600: read host-side only (the dae CLI + `docker compose`), never inside a container.
  await atomicWrite(filePath, body, { mode: 0o600 });
}

function quoteValue(value: string): string {
  if (/^[A-Za-z0-9_\-./:]+$/.test(value)) return value;
  // SEC-14: escape backslash and quote, AND newlines/CR — a raw newline would split the
  // dotenv file and inject a spurious KEY= entry on the next read. The reader (unquote /
  // dotenv) decodes these back.
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")}"`;
}
