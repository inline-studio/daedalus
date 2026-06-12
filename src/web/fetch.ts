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

// SEC-04/05: run the SSRF guard and follow redirects MANUALLY so every hop is checked — a
// public URL can 30x to an internal/metadata host. Each hop is a normal fetch() (still routed
// through the OneCLI proxy when enabled); the guard is only a go/no-go gate and never alters
// the request. Shared by fetchUrl (text) and fetchBytes (binary) so the check is single-sourced.
async function guardedFetch(
  url: string,
  opts: { userAgent?: string; allowHosts?: string[]; signal: AbortSignal },
): Promise<{ res: Response; finalUrl: string }> {
  const allowHosts = opts.allowHosts ?? [];
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
      signal: opts.signal,
    });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!loc) break;
    if (hop >= maxHops) throw new Error(`fetch: too many redirects (>${maxHops})`);
    await res.body?.cancel().catch(() => undefined); // free the socket before the next hop
    currentUrl = new URL(loc, currentUrl).toString();
  }
  return { res, finalUrl: currentUrl };
}

// Read a response body into a Buffer, hard-capped at maxBytes (truncates past the cap).
async function readCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader();
  if (!reader) return Buffer.from(await res.arrayBuffer());
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > maxBytes) {
      await reader.cancel().catch(() => undefined);
      chunks.push(value.slice(0, value.length - (bytes - maxBytes)));
      break;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

// BUG-11: decode UTF-8 dropping an incomplete multibyte sequence at the end. A byte-capped read
// can split a character; TextDecoder with {stream:true} buffers the partial trailing code point
// and — since we never flush — drops it cleanly instead of emitting a U+FFFD replacement char.
function decodeUtf8(buf: Buffer): string {
  return new TextDecoder("utf-8").decode(buf, { stream: true });
}

export async function fetchUrl(url: string, opts: FetchOptions = {}): Promise<FetchResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000);
  try {
    const { res, finalUrl } = await guardedFetch(url, {
      ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      ...(opts.allowHosts ? { allowHosts: opts.allowHosts } : {}),
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") ?? "";
    const buf = await readCapped(res, opts.maxBytes ?? 1_000_000);
    return finalize(finalUrl, res.status, contentType, decodeUtf8(buf), opts);
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchBytesOptions {
  maxBytes?: number; // hard cap on downloaded bytes (default 25 MB)
  timeoutMs?: number; // overall timeout (default 30s)
  userAgent?: string;
  allowHosts?: string[]; // exact-hostname SSRF allowlist (default none)
}

export interface FetchBytesResult {
  url: string;
  status: number;
  contentType: string;
  buffer: Buffer;
}

// SEC-05: SSRF-guarded, size-capped, time-bounded binary fetch. Used for inbound attachment
// URLs (raw bytes — images/PDFs/video — so no text conversion). Same guard as fetchUrl.
export async function fetchBytes(url: string, opts: FetchBytesOptions = {}): Promise<FetchBytesResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
  try {
    const { res, finalUrl } = await guardedFetch(url, {
      ...(opts.userAgent ? { userAgent: opts.userAgent } : {}),
      ...(opts.allowHosts ? { allowHosts: opts.allowHosts } : {}),
      signal: controller.signal,
    });
    const contentType = res.headers.get("content-type") ?? "";
    const buffer = await readCapped(res, opts.maxBytes ?? 25_000_000);
    return { url: finalUrl, status: res.status, contentType, buffer };
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
