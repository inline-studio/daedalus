// Secret storage abstraction. Two concerns:
//   1. Developer-facing CLI ergonomics — `dae secret save NAME`, etc.
//   2. Runtime resolution — when a config references ${NAME} and process.env doesn't have it.
//
// This is distinct from src/secrets/onecli.ts, which wires the OneCLI HTTP proxy that swaps
// placeholder API keys at the network edge. Both can be active simultaneously: secrets stored
// here are used at *config-load* time; the proxy intervenes at *request* time.

export interface SecretEntry {
  name: string;
  description?: string;
  // Returned only by stores that can list metadata; never the value.
}

// Backends that perform credential injection (e.g. OneCLI's gateway swapping placeholder
// keys for real ones at request time) need to know WHERE to inject. Simpler backends
// (.env.local) ignore this metadata.
export interface InjectionConfig {
  // HTTP header to set (e.g. "Authorization", "X-Subscription-Token").
  headerName: string;
  // How to format the header value. {value} is replaced with the real secret.
  // Default: "{value}". Common: "Bearer {value}".
  valueFormat?: string;
}

export interface SaveOptions {
  description?: string;
  // OneCLI-specific (and similar gateway backends): which outbound requests this credential
  // applies to. Glob-style pattern against host+path, e.g. "api.search.brave.com/*".
  urlPattern?: string;
  // Restrict which agent name(s) can use this credential. Backend-specific semantics.
  agent?: string;
  // How the gateway should inject the value into matching requests.
  injectionConfig?: InjectionConfig;
}

// Capabilities a backend declares so the CLI can surface clear errors when an op isn't supported.
export interface SecretsCapabilities {
  read: boolean;
  write: boolean;
  list: boolean;
  delete: boolean;
}

export interface SecretsBackend {
  readonly id: string;
  readonly capabilities: SecretsCapabilities;
  // Returns null if the secret doesn't exist. Throws on backend errors.
  get(name: string): Promise<string | null>;
  save(name: string, value: string, opts?: SaveOptions): Promise<void>;
  list(): Promise<SecretEntry[]>;
  delete(name: string): Promise<void>;
}

export class SecretsBackendUnavailable extends Error {
  constructor(
    readonly backendId: string,
    message: string,
  ) {
    super(message);
    this.name = "SecretsBackendUnavailable";
  }
}

export class SecretsOpUnsupported extends Error {
  constructor(
    readonly backendId: string,
    readonly op: keyof SecretsCapabilities,
    hint?: string,
  ) {
    super(`secrets backend '${backendId}' does not support '${op}'${hint ? `: ${hint}` : ""}`);
    this.name = "SecretsOpUnsupported";
  }
}
