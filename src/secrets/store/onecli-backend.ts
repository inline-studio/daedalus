import {
  SecretsBackendUnavailable,
  SecretsOpUnsupported,
  type SecretEntry,
  type SecretsBackend,
  type SecretsCapabilities,
} from "./base.js";

// OneCLI by design never reveals secret values — they exist inside the gateway and get
// injected into outbound HTTPS traffic at request time (see src/secrets/onecli.ts for the
// proxy wiring). So this backend supports `list` only:
//
//   GET /api/secrets  → metadata array (id, name, type, hostPattern, injectionConfig, …)
//
// `get`/`save`/`delete` are unsupported. Use the `onecli secrets {create,update,delete}`
// CLI directly — addressed by UUID and with a richer create schema than this backend
// would model.
export interface OneCliBackendOptions {
  baseUrl?: string;
  // Daemon API key (oc_...). Required for the list endpoint.
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
    write: false,
    list: true,
    delete: false,
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

  async save(_name: string, _value: string): Promise<void> {
    throw new SecretsOpUnsupported(
      this.id,
      "write",
      "OneCLI secrets are managed by `onecli secrets create --name ... --type ... --value ... --host-pattern ...` (addressed by UUID, richer schema). Use the OneCLI CLI directly.",
    );
  }

  async list(): Promise<SecretEntry[]> {
    const res = await this.request("GET", "/api/secrets");
    if (!res.ok) throw new Error(`onecli list failed: HTTP ${res.status}`);
    const body = (await res.json().catch(() => [])) as OneCliSecretRecord[];
    return body.map((b) => ({
      name: b.name,
      ...(b.hostPattern ? { description: `${b.type ?? "secret"} → ${b.hostPattern}` } : {}),
    }));
  }

  async delete(_name: string): Promise<void> {
    throw new SecretsOpUnsupported(
      this.id,
      "delete",
      "OneCLI secrets are deleted by UUID with `onecli secrets delete --id <uuid>`. Run `onecli secrets list` to find the id.",
    );
  }

  private async request(method: string, pathPart: string): Promise<Response> {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    try {
      return await fetch(`${this.baseUrl}${pathPart}`, { method, headers });
    } catch (err) {
      throw new SecretsBackendUnavailable(
        this.id,
        `cannot reach OneCLI at ${this.baseUrl}: ${(err as Error).message}`,
      );
    }
  }
}
