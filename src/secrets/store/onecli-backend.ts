import {
  SecretsBackendUnavailable,
  SecretsOpUnsupported,
  type SaveOptions,
  type SecretEntry,
  type SecretsBackend,
  type SecretsCapabilities,
} from "./base.js";

// OneCLI HTTP API backend.
//
// OneCLI's primary user surface is its dashboard at http://localhost:10254. It also serves a
// REST API on the same port. The exact shape isn't fully documented yet so this backend uses
// best-effort endpoints and surfaces clear errors when an op isn't supported — telling the user
// to manage that secret via the dashboard instead.
//
// Conventional endpoints we try:
//   GET    /api/secrets             → list (200 + array)
//   GET    /api/secrets/:name       → get (200 + { value }, or 404)
//   POST   /api/secrets             → save (body: { name, value, description? })
//   DELETE /api/secrets/:name       → delete
//
// If any of those return 404 the backend marks the op unsupported. Adjust the paths here to
// match your OneCLI version once the API stabilises.
export interface OneCliBackendOptions {
  baseUrl?: string;
  token?: string;
  // If true, attempt the call; if 404 throw SecretsOpUnsupported.
  // If false, throw SecretsOpUnsupported immediately (e.g. "we know this version doesn't support it").
  enableWrites?: boolean;
}

export class OneCliSecretsBackend implements SecretsBackend {
  readonly id = "onecli";
  readonly capabilities: SecretsCapabilities;
  private baseUrl: string;
  private token: string | undefined;

  constructor(opts: OneCliBackendOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:10254").replace(/\/$/, "");
    this.token = opts.token;
    // Optimistic — we'll discover at call time. Marking all true; if 404, callers get a clear error.
    this.capabilities = { read: true, write: opts.enableWrites !== false, list: true, delete: true };
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl, { method: "GET", headers: this.headers() });
      return res.ok || res.status === 404; // any response means it's up
    } catch {
      return false;
    }
  }

  async get(name: string): Promise<string | null> {
    const res = await this.request("GET", `/api/secrets/${encodeURIComponent(name)}`);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`onecli get failed: HTTP ${res.status}`);
    const body = (await res.json().catch(() => ({}))) as { value?: string };
    return body.value ?? null;
  }

  async save(name: string, value: string, opts?: SaveOptions): Promise<void> {
    // OneCLI's whole point is that the gateway swaps placeholder keys for real ones at the
    // network edge — so the credential record needs to know WHEN (urlPattern), for WHOM
    // (agent), and HOW (injectionConfig: header + value format) to perform the swap.
    const payload: Record<string, unknown> = { name, value };
    if (opts?.description) payload.description = opts.description;
    if (opts?.urlPattern) payload.urlPattern = opts.urlPattern;
    if (opts?.agent) payload.agent = opts.agent;
    if (opts?.injectionConfig) {
      payload.injectionConfig = {
        headerName: opts.injectionConfig.headerName,
        valueFormat: opts.injectionConfig.valueFormat ?? "{value}",
      };
    }
    const res = await this.request("POST", `/api/secrets`, payload);
    if (res.status === 404 || res.status === 405) {
      throw new SecretsOpUnsupported(
        this.id,
        "write",
        `OneCLI at ${this.baseUrl} returned ${res.status}; manage secrets via the dashboard at ${this.baseUrl}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`onecli save failed: HTTP ${res.status}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
  }

  async list(): Promise<SecretEntry[]> {
    const res = await this.request("GET", `/api/secrets`);
    if (res.status === 404) {
      throw new SecretsOpUnsupported(this.id, "list", `OneCLI at ${this.baseUrl} doesn't expose /api/secrets`);
    }
    if (!res.ok) throw new Error(`onecli list failed: HTTP ${res.status}`);
    const body = (await res.json().catch(() => [])) as Array<{ name: string; description?: string }>;
    return body.map((b) => ({ name: b.name, ...(b.description ? { description: b.description } : {}) }));
  }

  async delete(name: string): Promise<void> {
    const res = await this.request("DELETE", `/api/secrets/${encodeURIComponent(name)}`);
    if (res.status === 404 || res.status === 405) {
      throw new SecretsOpUnsupported(this.id, "delete", "manage via the dashboard");
    }
    if (!res.ok) throw new Error(`onecli delete failed: HTTP ${res.status}`);
  }

  private async request(method: string, pathPart: string, body?: unknown): Promise<Response> {
    try {
      return await fetch(`${this.baseUrl}${pathPart}`, {
        method,
        headers: { ...this.headers(), ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      throw new SecretsBackendUnavailable(
        this.id,
        `cannot reach OneCLI at ${this.baseUrl}: ${(err as Error).message}`,
      );
    }
  }
}
