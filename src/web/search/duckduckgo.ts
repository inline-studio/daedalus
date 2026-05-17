import { parse } from "node-html-parser";
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

    const root = parse(html);
    const out: SearchResult[] = [];
    for (const el of root.querySelectorAll(".result")) {
      if (out.length >= limit) break;
      const titleEl = el.querySelector(".result__a");
      const title = titleEl?.text.trim() ?? "";
      let href = titleEl?.getAttribute("href") ?? "";
      // DDG wraps URLs in a redirect like //duckduckgo.com/l/?uddg=<encoded>
      const m = href.match(/[?&]uddg=([^&]+)/);
      if (m) href = decodeURIComponent(m[1]!);
      if (href.startsWith("//")) href = "https:" + href;
      const snippet = el.querySelector(".result__snippet")?.text.trim() ?? "";
      const source = el.querySelector(".result__url")?.text.trim() ?? "";
      if (title && href) out.push({ title, url: href, snippet, source });
    }
    return out;
  }
}
