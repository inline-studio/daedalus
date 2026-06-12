import type { ToolImpl } from "./base.js";
import type { WebConfig } from "../config/schema.js";
import { fetchUrl } from "../web/fetch.js";
import { buildSearchProvider } from "../web/search/index.js";
import { WEB_FETCH_MAX_CHARS, capChars } from "./limits.js";

export function webFetchTool(config: WebConfig): ToolImpl {
  return {
    definition: {
      name: "web_fetch",
      description:
        "Fetch a URL and return its content. HTML is auto-converted to markdown with chrome (nav/footer/scripts) stripped. JSON, RSS, and plain text are returned as-is. Output is capped at ~40k chars; if a page is larger, fetch a more specific URL or use web_search to find the right one. Use this to read documentation, articles, GitHub READMEs, etc.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "Absolute URL to fetch (http or https)." },
          raw: {
            type: "boolean",
            description: "If true, skip HTML→markdown conversion and return raw text.",
            default: false,
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    async invoke(input) {
      const url = String(input.url ?? "");
      if (!/^https?:\/\//i.test(url)) {
        return { content: `Error: url must start with http:// or https://`, isError: true };
      }
      try {
        const result = await fetchUrl(url, {
          maxBytes: config.fetch.maxBytes,
          timeoutMs: config.fetch.timeoutMs,
          ...(config.fetch.userAgent ? { userAgent: config.fetch.userAgent } : {}),
          allowHosts: config.fetch.allowHosts,
          raw: Boolean(input.raw),
        });

        if (result.page) {
          const lines = [
            `URL: ${result.url}`,
            `Title: ${result.page.title}`,
            `Status: ${result.status}`,
            `Bytes: ${result.byteLength}${result.page.wasTruncated ? " (truncated)" : ""}`,
            "",
            capChars(result.page.contentMarkdown, WEB_FETCH_MAX_CHARS),
          ];
          return { content: lines.join("\n") };
        }

        const body = result.rawText ?? "";
        return {
          content: [
            `URL: ${result.url}`,
            `Status: ${result.status}`,
            `Content-Type: ${result.contentType}`,
            `Bytes: ${result.byteLength}`,
            "",
            capChars(body, WEB_FETCH_MAX_CHARS),
          ].join("\n"),
        };
      } catch (err) {
        return { content: `web_fetch failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

export function webSearchTool(config: WebConfig): ToolImpl {
  return {
    definition: {
      name: "web_search",
      description:
        "Search the web. Returns ranked results (title, URL, snippet). After you find a relevant URL, use web_fetch to read its full content.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number", description: "Max results (1–20).", default: 8 },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async invoke(input) {
      const provider = buildSearchProvider(config);
      if (!provider) {
        return {
          content:
            "web_search has no provider configured. Set web.search.provider to 'duckduckgo' (no key, default) or 'brave' (needs apiKey) in daedalus.config.yaml — or run `dae setup search`.",
          isError: true,
        };
      }
      try {
        const limit = clampInt(input.limit, 1, 20, 8);
        const results = await provider.search(String(input.query ?? ""), { limit });
        if (results.length === 0) return { content: "No results.", isError: false };
        const body = results
          .map(
            (r, i) =>
              `${i + 1}. ${r.title}\n   ${r.url}${r.source ? ` (${r.source})` : ""}\n   ${r.snippet}`,
          )
          .join("\n\n");
        return { content: `Provider: ${provider.id}\n\n${body}` };
      } catch (err) {
        return { content: `web_search failed: ${(err as Error).message}`, isError: true };
      }
    },
  };
}

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
