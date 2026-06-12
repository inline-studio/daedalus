import fs from "node:fs/promises";
import path from "node:path";

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

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = out.join("\n") + (out.length && out[out.length - 1] !== "" ? "\n" : "");
  // SEC-08: this file holds secrets (.env.local, compose .env). Create it owner-only (0600)
  // and tighten an existing file that an earlier version may have left world-readable (0644).
  // `mode` on writeFile only applies on CREATE, so the explicit chmod covers a pre-existing
  // file. These files are read host-side only (the dae CLI + `docker compose`), never inside
  // a container, so 0600 is safe. The chmod is best-effort so an exotic fs can't break setup.
  await fs.writeFile(filePath, body, { mode: 0o600, encoding: "utf8" });
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

function quoteValue(value: string): string {
  if (/^[A-Za-z0-9_\-./:]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
