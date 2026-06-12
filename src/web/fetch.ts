import { htmlToMarkdown, type ExtractedPage } from "./markdown.js";
import { assertPublicHostAllowed } from "./ssrf.js";

export interface FetchOptions {
  maxBytes?: number; // hard cap on body size before parsing
  timeoutMs?: number;
  userAgent?: string;
  // If true, return raw text without HTML→markdown conversion (useful for JSON / RSS / robots.txt).
  raw?: boolean;
  // SEC-04: exact-hostname allowlist that bypasses the SSRF guard (default none).
  allowHosts?: string[];
}

export interface FetchResult {
  url: string; // final URL after redirects
  status: number;
  contentType: string;
  page?: ExtractedPage; // present when content-type is HTML
  rawText?: string; // present when raw=true or non-HTML
  byteLength: number;
}

const DEFAULT_UA = "Daedalus/0.1 (+https://github.com/inline-studio/daedalus)";

export async function fetchUrl(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const allowHosts = opts.allowHosts ?? [];
    // SEC-04: follow redirects MANUALLY so every hop is SSRF-checked — a public URL can 30x
    // to an internal/metadata host. Each hop is a normal fetch() (still routed through the
    // OneCLI proxy when enabled); the guard is only a go/no-go gate and never alters the request.
    const maxHops = 5;
    let currentUrl = url;
    let res: Response;
    for (let hop = 0; ; hop++) {
      await assertPublicHostAllowed(currentUrl, allowHosts);
      res = await fetch(currentUrl, {
        headers: {
          "User-Agent": opts.userAgent ?? DEFAULT_UA,
          Accept: "text/html, application/xhtml+xml, application/xml;q=0.9, */*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!loc) break;
      if (hop >= maxHops) throw new Error(`web_fetch: too many redirects (>${maxHops})`);
      await res.body?.cancel().catch(() => undefined); // free the socket before the next hop
      currentUrl = new URL(loc, currentUrl).toString();
    }

    const finalUrl = currentUrl;
    const contentType = res.headers.get("content-type") ?? "";
    const maxBytes = opts.maxBytes ?? 1_000_000;

    // Read body with a size cap to avoid OOM on huge pages.
    const reader = res.body?.getReader();
    if (!reader) {
      const text = await res.text();
      return finalize(finalUrl, res.status, contentType, text, opts);
    }
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        chunks.push(value.slice(0, value.length - (bytes - maxBytes)));
        bytes = maxBytes;
        break;
      }
      chunks.push(value);
    }
    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    const text = buf.toString("utf8");
    return finalize(finalUrl, res.status, contentType, text, opts);
  } finally {
    clearTimeout(timer);
  }
}

function finalize(
  url: string,
  status: number,
  contentType: string,
  text: string,
  opts: FetchOptions,
): FetchResult {
  const byteLength = Buffer.byteLength(text, "utf8");
  const isHtml = /text\/html|application\/xhtml/i.test(contentType) || /<\s*html/i.test(text);
  if (opts.raw || !isHtml) {
    return { url, status, contentType, rawText: text, byteLength };
  }
  const page = htmlToMarkdown(text, url);
  return { url, status, contentType, page, byteLength };
}
