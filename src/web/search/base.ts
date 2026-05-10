export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string; // human-readable host
}

export interface SearchProvider {
  readonly id: string;
  readonly requiresKey: boolean;
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
}

export class SearchError extends Error {
  constructor(
    message: string,
    readonly providerId: string,
  ) {
    super(message);
    this.name = "SearchError";
  }
}
