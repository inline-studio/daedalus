import {
  SecretsBackendUnavailable,
  type SaveOptions,
  type SecretEntry,
  type SecretsBackend,
  type SecretsCapabilities,
} from "./base.js";

// OneCLI keeps secret VALUES inside the gateway and injects them into outbound traffic
// at request time (see src/secrets/onecli.ts for the proxy wiring) — it never reveals a
// value, so `get` is unsupported. But it does expose a REST API for managing the secret
// records, which this backend drives:
//
//   GET    /api/secrets         → metadata array (id, name, type, hostPattern, injectionConfig)
//   POST   /api/secrets         → create { name, type, value, hostPattern, injectionConfig }
//   DELETE /api/secrets/:id     → remove
//
// In local/single-user mode the API needs no auth; cloud deployments enforce a Bearer key.
export interface OneCliBackendOptions {
  baseUrl?: string;
  // Daemon API key (oc_...). Sent as Bearer; ignored by local-mode gateways.
  token?: string;
}

interface OneCliSecretRecord {
  id: string;
  name: string;
  type?: string;
  hostPattern?: string;
}

export class OneCliSecretsBackend implements SecretsBackend {
  readonly id = "onecli";
  readonly capabilities: SecretsCapabilities = {
    read: false,
    write: true,
    list: true,
    delete: true,
  };
  private baseUrl: string;
  private token: string | undefined;

  constructor(opts: OneCliBackendOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:10254").replace(/\/$/, "");
    this.token = opts.token;
  }

  async ping(): Promise<boolean> {
    try {
      const res = await fetch(this.baseUrl, { method: "GET" });
      return res.ok || res.status === 404; // any response means it's up
    } catch {
      return false;
    }
  }

  async get(_name: string): Promise<string | null> {
    return null;
  }

  // Create (or replace) a secret. OneCLI injects it into matching outbound requests, so a
  // host pattern + header (or param) is required. We model the common header-injection case
  // via SaveOptions.urlPattern (host) + injectionConfig.headerName/valueFormat.
  async save(name: string, value: string, opts?: SaveOptions): Promise<void> {
    const hostPattern = opts?.urlPattern;
    const headerName = opts?.injectionConfig?.headerName;
    if (!hostPattern || !headerName) {
      throw new Error(
        "OneCLI secrets need a host pattern and a header to inject. " +
          "Pass -u <host-pattern> and -H <header-name> (e.g. " +
          "-u api.search.brave.com -H X-Subscription-Token).",
      );
    }
    const fields = {
      value,
      hostPattern,
      injectionConfig: {
        headerName,
        valueFormat: opts?.injectionConfig?.valueFormat ?? "{value}",
      },
    };
    // Upsert: update an existing secret in place (PATCH preserves the id and avoids a
    // delete-then-create window where a failure would lose the secret); create otherwise.
    const existing = (await this.listRaw()).find((s) => s.name === name);
    const res = existing
      ? await this.request("PATCH", `/api/secrets/${existing.id}`, fields)
      : await this.request("POST", "/api/secrets", { name, type: "generic", ...fields });
    if (!res.ok) {
      throw new Error(
        `onecli ${existing ? "update" : "create"} failed: HTTP ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`,
      );
    }
  }

  async list(): Promise<SecretEntry[]> {
    return (await this.listRaw()).map((b) => ({
      name: b.name,
      ...(b.hostPattern ? { description: `${b.type ?? "secret"} → ${b.hostPattern}` } : {}),
    }));
  }

  async delete(name: string): Promise<void> {
    const existing = (await this.listRaw()).find((s) => s.name === name);
    if (!existing) return; // idempotent — nothing to delete
    await this.deleteById(existing.id);
  }

  private async listRaw(): Promise<OneCliSecretRecord[]> {
    const res = await this.request("GET", "/api/secrets");
    if (!res.ok) throw new Error(`onecli list failed: HTTP ${res.status}`);
    return (await res.json().catch(() => [])) as OneCliSecretRecord[];
  }

  private async deleteById(id: string): Promise<void> {
    const res = await this.request("DELETE", `/api/secrets/${id}`);
    if (!res.ok && res.status !== 404) {
      throw new Error(`onecli delete failed: HTTP ${res.status}`);
    }
  }

  private async request(method: string, pathPart: string, body?: unknown): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    try {
      return await fetch(`${this.baseUrl}${pathPart}`, {
        method,
        headers,
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
