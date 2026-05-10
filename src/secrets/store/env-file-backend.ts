import fs from "node:fs/promises";
import path from "node:path";
import { upsertEnvFile } from "../../setup/env-file.js";
import type { SaveOptions, SecretEntry, SecretsBackend, SecretsCapabilities } from "./base.js";
import { log } from "../../log.js";

// Backs onto a dotenv file (.env.local by default). Always available, no daemon needed.
// Trade-off: secrets sit in plaintext on disk. Fine for dev; use OneCLI / a Vault for prod.
export class EnvFileSecretsBackend implements SecretsBackend {
  readonly id = "env-file";
  readonly capabilities: SecretsCapabilities = {
    read: true,
    write: true,
    list: true,
    delete: true,
  };

  constructor(private filePath: string) {}

  private async readFile(): Promise<string[]> {
    try {
      const text = await fs.readFile(this.filePath, "utf8");
      return text.split(/\r?\n/);
    } catch {
      return [];
    }
  }

  async get(name: string): Promise<string | null> {
    const lines = await this.readFile();
    const re = new RegExp(`^${escapeRegex(name)}=(.*)$`);
    for (const line of lines) {
      const m = line.match(re);
      if (m) return unquote(m[1]!);
    }
    return null;
  }

  async save(name: string, value: string, opts?: SaveOptions): Promise<void> {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`secret name must match [A-Za-z_][A-Za-z0-9_]* — got '${name}'`);
    }
    if (opts?.urlPattern || opts?.injectionConfig) {
      log.warn(
        { backend: this.id },
        "env-file backend doesn't perform injection — urlPattern/injectionConfig ignored. Use OneCLI for gateway-side credential injection.",
      );
    }
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await upsertEnvFile(this.filePath, { [name]: value });
  }

  async list(): Promise<SecretEntry[]> {
    const lines = await this.readFile();
    const out: SecretEntry[] = [];
    for (const line of lines) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
      if (m) out.push({ name: m[1]! });
    }
    return out;
  }

  async delete(name: string): Promise<void> {
    const lines = await this.readFile();
    const re = new RegExp(`^${escapeRegex(name)}=`);
    const filtered = lines.filter((l) => !re.test(l));
    if (filtered.length === lines.length) return; // not present
    await fs.writeFile(this.filePath, filtered.join("\n"), "utf8");
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function unquote(v: string): string {
  if (v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return v;
}
