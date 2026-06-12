import { parse } from "node-html-parser";
import TurndownService from "turndown";

// HTML → markdown with light main-content extraction. Strips scripts, styles, nav,
// footer, and obvious chrome. Doesn't run JS, doesn't bring up a browser. For sites
// that require rendering, mount a playwright/puppeteer MCP server.

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
  linkStyle: "inlined",
});

// Drop tags whose content is rarely useful and often huge.
turndown.remove(["script", "style", "noscript", "iframe", "svg"]);

const SELECTORS_TO_DROP = [
  "script",
  "style",
  "noscript",
  "nav",
  "header[role='banner']",
  "footer",
  "aside",
  "form",
  ".cookie",
  ".cookie-banner",
  "[aria-hidden='true']",
];

// Try in order until one matches and yields a non-trivial body.
const MAIN_CONTENT_SELECTORS = ["article", "main", "[role='main']", "#content", ".content", "body"];

export interface ExtractedPage {
  url: string;
  title: string;
  contentMarkdown: string;
  rawHtml: string;
  byteLength: number;
  wasTruncated: boolean;
}

export function htmlToMarkdown(html: string, sourceUrl: string, maxBytes = 200_000): ExtractedPage {
  const root = parse(html);
  const title =
    root.querySelector("title")?.text.trim() ||
    root.querySelector("h1")?.text.trim() ||
    sourceUrl;

  for (const sel of SELECTORS_TO_DROP) {
    root.querySelectorAll(sel).forEach((el) => el.remove());
  }

  let mainHtml = "";
  for (const sel of MAIN_CONTENT_SELECTORS) {
    const el = root.querySelector(sel);
    if (el && el.text.trim().length > 200) {
      mainHtml = el.innerHTML;
      break;
    }
  }
  if (!mainHtml) mainHtml = root.querySelector("body")?.innerHTML ?? html;

  let md = turndown.turndown(mainHtml).trim();
  // Collapse 3+ blank lines to 2.
  md = md.replace(/\n{3,}/g, "\n\n");

  const wasTruncated = Buffer.byteLength(md, "utf8") > maxBytes;
  if (wasTruncated) {
    md = md.slice(0, maxBytes) + "\n\n[truncated]";
  }
  // BUG-10: report the length of the content actually returned (post-truncation), not the
  // pre-truncation size.
  const byteLength = Buffer.byteLength(md, "utf8");

  return {
    url: sourceUrl,
    title,
    contentMarkdown: md,
    rawHtml: html,
    byteLength,
    wasTruncated,
  };
}
