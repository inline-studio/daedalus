import { SearchError, type SearchProvider, type SearchResult } from "./base.js";

// Brave Search API — clean JSON, free tier 2k/mo. Requires X-Subscription-Token header.
// Docs: https://api.search.brave.com/app/documentation
export class BraveProvider implements SearchProvider {
  readonly id = "brave";
  readonly requiresKey = true;

  constructor(private apiKey: string) {}

  async search(query: string, opts: { limit?: number } = {}): Promise<SearchResult[]> {
    if (!this.apiKey) throw new SearchError("Brave Search requires an API key", this.id);
    const limit = Math.min(opts.limit ?? 8, 20);
    const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": this.apiKey,
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new SearchError(`brave search HTTP ${res.status}: ${body.slice(0, 200)}`, this.id);
    }
    const json = (await res.json()) as {
      web?: { results?: Array<{ title: string; url: string; description: string; meta_url?: { hostname?: string } }> };
    };
    return (json.web?.results ?? []).map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.description,
      ...(r.meta_url?.hostname ? { source: r.meta_url.hostname } : {}),
    }));
  }
}
