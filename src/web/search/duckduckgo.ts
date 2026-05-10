import * as cheerio from "cheerio";
import { SearchError, type SearchProvider, type SearchResult } from "./base.js";

// DuckDuckGo HTML scrape. Uses the no-JS endpoint at html.duckduckgo.com.
// No API key required, but it's an unofficial scrape — DDG may rate-limit or change layout.
// Good default; users who want stability should configure Brave/Tavily/Serp/Exa.
export class DuckDuckGoProvider implements SearchProvider {
  readonly id = "duckduckgo";
  readonly requiresKey = false;

  async search(query: string, opts: { limit?: number } = {}): Promise<SearchResult[]> {
    const limit = opts.limit ?? 8;
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    let html: string;
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          Accept: "text/html",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      throw new SearchError(`duckduckgo fetch failed: ${(err as Error).message}`, this.id);
    }

    const $ = cheerio.load(html);
    const out: SearchResult[] = [];
    $(".result").each((_, el) => {
      if (out.length >= limit) return false;
      const titleEl = $(el).find(".result__a").first();
      const title = titleEl.text().trim();
      let url = titleEl.attr("href") ?? "";
      // DDG wraps URLs in a redirect like //duckduckgo.com/l/?uddg=<encoded>
      const m = url.match(/[?&]uddg=([^&]+)/);
      if (m) url = decodeURIComponent(m[1]!);
      if (url.startsWith("//")) url = "https:" + url;
      const snippet = $(el).find(".result__snippet").text().trim();
      const source = $(el).find(".result__url").text().trim();
      if (title && url) out.push({ title, url, snippet, source });
      return undefined;
    });
    return out;
  }
}
