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
  await fs.writeFile(filePath, out.join("\n") + (out.length && out[out.length - 1] !== "" ? "\n" : ""), "utf8");
}

function quoteValue(value: string): string {
  if (/^[A-Za-z0-9_\-./:]+$/.test(value)) return value;
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
