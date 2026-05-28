// Convert Claude's CommonMark output into the limited HTML dialect Telegram
// accepts, so structured replies don't show up as raw `**`/`###`/`|` noise.
//
// Why HTML and not MarkdownV2: Telegram's MarkdownV2 demands every special
// character (`_*[]()~>#+-=|{}.!`) be escaped outside formatting context, and
// one missed escape returns HTTP 400 — the whole message fails to send. HTML
// only requires escaping `<`, `>`, `&`. Far safer.
//
// Telegram HTML only supports inline emphasis tags + <pre>/<code>/<a>/<blockquote>.
// There is NO <table>, <h1>, <ul>, or <li>. So structured CommonMark constructs
// have to be rewritten into the emphasis-only dialect:
//
//   - `**x**` / `__x__`         -> <b>x</b>
//   - `*x*`                     -> <i>x</i>       (single underscore italic
//                                                   intentionally NOT mapped —
//                                                   too noisy with identifiers
//                                                   like `some_var_name`)
//   - `~~x~~`                   -> <s>x</s>
//   - `[label](url)`            -> <a href="url">label</a>
//   - `` `code` ``              -> <code>code</code>
//   - triple-backtick blocks    -> <pre>…</pre>   (with optional language hint)
//   - `# Heading` … `###### …`  -> <b>Heading</b> on its own line + blank line
//   - GFM tables                -> per-row stanza (see renderTableStanza below)
//   - `- item` / `* item`       -> `• item`       (no <ul>/<li> in Telegram HTML)
//   - `> quoted`                -> <blockquote>quoted</blockquote>
//
// Order matters:
//   1. extract triple-backtick blocks, GFM tables, inline code into
//      placeholders — their bodies must NOT be touched by the structural
//      passes below
//   2. HTML-escape EVERYTHING else
//   3. block-level transforms: headings, lists, blockquotes (multi-line regexes
//      that depend on line starts)
//   4. inline emphasis: bold (`**`) BEFORE italic (`*`) — otherwise the italic
//      regex eats the bold delimiters
//   5. links
//   6. restore placeholders (with their bodies already pre-escaped + pre-formatted)

// Printable sentinels for placeholders. Chosen because the combination is
// vanishingly unlikely to appear in a real assistant reply, is plain ASCII
// so htmlEscape leaves it alone, and is visible if you ever have to debug
// the output mid-pipeline.
const PH_OPEN = "␂DAE␂"; // U+2402 SYMBOL FOR START OF TEXT
const PH_CLOSE = "␃DAE␃"; // U+2403 SYMBOL FOR END OF TEXT

export function markdownToTelegramHtml(md: string): string {
  if (!md) return "";

  // 1a. Triple-backtick blocks. Optional language tag on the opening fence.
  //     The body is captured verbatim and html-escaped on emit.
  const codeBlocks: string[] = [];
  let s = md.replace(/```([\w-]*)\n?([\s\S]*?)```/g, (_, lang: string, body: string) => {
    const idx = codeBlocks.length;
    const escaped = htmlEscape(body.replace(/\n$/, ""));
    codeBlocks.push(
      lang
        ? `<pre><code class="language-${attrEscape(lang)}">${escaped}</code></pre>`
        : `<pre>${escaped}</pre>`,
    );
    return `${PH_OPEN}CB${idx}${PH_CLOSE}`;
  });

  // 1b. GFM tables. Match header + separator + N body rows. Each match becomes
  //     a per-row stanza string (Telegram has no <table>). We extract into a
  //     placeholder so later passes don't trip on the pipes / inline formatting
  //     INSIDE cells (we apply inline formatting per-cell, once, here).
  const tables: string[] = [];
  s = s.replace(
    /(?:^|\n)(\|[^\n]+\|\n\|[\s:|-]+\|\n(?:\|[^\n]+\|\n?)*)/g,
    (match, body: string) => {
      const stanza = renderTableStanza(body.trim());
      if (stanza === null) return match; // not a real table — leave it alone
      const idx = tables.length;
      tables.push(stanza);
      // Preserve any leading newline the outer pattern consumed so the
      // surrounding paragraph structure isn't broken.
      const lead = match.startsWith("\n") ? "\n" : "";
      return `${lead}${PH_OPEN}TB${idx}${PH_CLOSE}\n`;
    },
  );

  // 1c. Inline code.
  const inline: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, body: string) => {
    const idx = inline.length;
    inline.push(`<code>${htmlEscape(body)}</code>`);
    return `${PH_OPEN}IC${idx}${PH_CLOSE}`;
  });

  // 2. Escape the rest. The PH_* sentinels are plain ASCII so they survive
  //    htmlEscape unchanged.
  s = htmlEscape(s);

  // 3. Block-level transforms (multi-line — must run on raw line-starts
  //    BEFORE inline emphasis chews the line shape).
  //
  // 3a. Headings: `#` through `######` at line start, optional space, text.
  //     All levels collapse to <b> — Telegram has no real heading element.
  //     A trailing newline keeps them visually separated from the next paragraph.
  s = s.replace(/^(#{1,6})[ \t]+(.+?)[ \t]*#*$/gm, (_, _hashes: string, text: string) => {
    return `<b>${text}</b>`;
  });

  // 3b. Unordered-list bullets: `- ` or `* ` at line start (with optional
  //     leading whitespace for nested-ish lists). Replace the marker only;
  //     leave the rest of the line for inline formatting.
  s = s.replace(/^([ \t]*)[-*][ \t]+/gm, "$1• ");

  // 3c. Blockquote lines: `> text`. Run-of-`>`-prefixed lines collapse into a
  //     single <blockquote>. Telegram supports the tag natively (Bot API 6.x+).
  //     Note: this runs AFTER htmlEscape, so the literal `>` has become `&gt;`
  //     — match that, not raw `>`.
  s = s.replace(/(?:^|\n)((?:&gt;[ \t]?[^\n]*\n?)+)/g, (_, block: string) => {
    const inner = block
      .split("\n")
      .map((line) => line.replace(/^&gt;[ \t]?/, ""))
      .join("\n")
      .replace(/\n+$/, "");
    return `\n<blockquote>${inner}</blockquote>\n`;
  });

  // 4. Inline emphasis. Bold FIRST so its `**` delimiters are gone before
  //    the italic pass runs.
  s = s.replace(/\*\*([^\n*][\s\S]*?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^\n_][\s\S]*?)__/g, "<b>$1</b>");
  // Italic: require the opening `*` to be at start-of-line or preceded by a
  // non-word/non-asterisk char, and the closing `*` to be followed by the
  // same, so `* item` (list marker — already converted above) and `var*name`
  // (identifier middle) don't accidentally start an italic run.
  s = s.replace(/(^|[^\w*])\*([^\s*][^*\n]*?)\*(?=$|[^\w*])/g, "$1<i>$2</i>");
  s = s.replace(/~~([\s\S]+?)~~/g, "<s>$1</s>");

  // 5. Links. The URL captured here was htmlEscape'd in step 2, which means
  //    `&` already became `&amp;`. That's correct for inserting into an href.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
    return `<a href="${url}">${label}</a>`;
  });

  // 6. Restore placeholders.
  s = s.replace(
    new RegExp(`${PH_OPEN}CB(\\d+)${PH_CLOSE}`, "g"),
    (_, n: string) => codeBlocks[Number(n)] ?? "",
  );
  s = s.replace(
    new RegExp(`${PH_OPEN}TB(\\d+)${PH_CLOSE}`, "g"),
    (_, n: string) => tables[Number(n)] ?? "",
  );
  s = s.replace(
    new RegExp(`${PH_OPEN}IC(\\d+)${PH_CLOSE}`, "g"),
    (_, n: string) => inline[Number(n)] ?? "",
  );

  return s;
}

// Strip markdown markers for plain-text fallback (when Telegram rejects HTML
// — a defensive belt for malformed input we couldn't sanitize). Removes the
// syntactic noise — emphasis tokens, link brackets, heading hashes, list
// markers — without trying to preserve any styling.
export function stripMarkdownForPlain(md: string): string {
  if (!md) return "";
  let s = md;
  // Link: keep the label, drop the URL.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, "$1");
  // Emphasis tokens.
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, "$1");
  s = s.replace(/__([\s\S]+?)__/g, "$1");
  s = s.replace(/(^|[^\w*])\*([^\s*][^*\n]*?)\*(?=$|[^\w*])/g, "$1$2");
  s = s.replace(/~~([\s\S]+?)~~/g, "$1");
  // Heading hashes (keep the heading text).
  s = s.replace(/^#{1,6}[ \t]+(.+?)[ \t]*#*$/gm, "$1");
  // List bullets — keep the item, replace the marker with a dot.
  s = s.replace(/^([ \t]*)[-*][ \t]+/gm, "$1• ");
  // Blockquote prefix.
  s = s.replace(/^>[ \t]?/gm, "");
  // Inline code: keep the body, drop the backticks.
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // Code fences: keep the body, drop the fence + language tag.
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1");
  return s;
}

// Render a GFM table block as a per-row stanza. Returns null if the block
// doesn't actually look like a table — caller leaves it as-is in that case.
//
// Telegram HTML has no <table>. The alternatives are:
//   (a) a <pre> monospace block — preserves alignment but wraps badly on
//       mobile-width screens, especially for tables with descriptive text
//       columns like "✓ Growing (5+ years consecutive increases)"
//   (b) per-row stanza — first column becomes the bold row label, remaining
//       columns become "<i>Header</i>: value" lines indented under it
//
// We pick (b). For a stock-comparison table the per-row stanza is much more
// legible on a phone screen than wrapped monospace.
//
// Cells may contain inline markdown (`**bold**`, `*italic*`, links, code).
// We escape + apply the inline passes per-cell HERE so later passes don't
// re-process them (the cells live inside a placeholder until the very end).
function renderTableStanza(block: string): string | null {
  const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const hdr = lines[0];
  const sep = lines[1];
  if (!hdr || !sep) return null;
  if (!/^\|.+\|$/.test(hdr)) return null;
  if (!/^\|[\s:|-]+\|$/.test(sep)) return null;
  // Header and separator must have the same number of pipes — guards against
  // a paragraph that happens to contain a stray |---| line.
  if ((hdr.match(/\|/g) ?? []).length !== (sep.match(/\|/g) ?? []).length) return null;

  const cells = (line: string): string[] =>
    line.slice(1, -1).split("|").map((c) => c.trim());

  const headers = cells(hdr);
  const bodyLines = lines.slice(2);
  // Strict: every post-separator line must be a pipe row. Mixing prose into
  // the block would otherwise be silently dropped. Bail out and let the
  // caller leave the block as a normal paragraph.
  for (const l of bodyLines) {
    if (!/^\|.+\|$/.test(l)) return null;
  }

  const out: string[] = [];
  for (const line of bodyLines) {
    const row = cells(line);
    // Pad/truncate to header count.
    while (row.length < headers.length) row.push("");
    if (row.length > headers.length) row.length = headers.length;
    // Row label: if the cell content is already a single <b>…</b> (e.g. the
    // agent wrote `**Games Workshop**`), drop the inner tags so we don't end
    // up with `<b><b>…</b></b>` — Telegram accepts it but it's redundant.
    const label = unwrapIfBold(formatCell(row[0] ?? ""));
    out.push(`<b>${label}</b>`);
    for (let i = 1; i < row.length; i++) {
      const header = formatCell(headers[i] ?? "");
      const value = formatCell(row[i] ?? "");
      // Two-space indent + "Header: value" — readable on a phone, no horizontal
      // alignment required.
      out.push(`  <i>${header}</i>: ${value}`);
    }
    out.push(""); // blank line between rows for visual separation
  }
  return out.join("\n").replace(/\n+$/, "");
}

function unwrapIfBold(s: string): string {
  const m = /^<b>([\s\S]*)<\/b>$/.exec(s);
  // Only unwrap when the WHOLE string is one bold span; if there's other
  // content around it (e.g. "<b>A</b> and <b>B</b>") we leave it intact.
  return m && !m[1]!.includes("</b>") ? m[1]! : s;
}

// Per-cell formatting: html-escape, then re-apply the inline emphasis passes
// so `**bold**` inside a cell renders as bold (and not as literal asterisks).
// Cells are short and contain only inline content, so we don't need the full
// pipeline — just escape + the inline regexes.
function formatCell(raw: string): string {
  let s = htmlEscape(raw);
  s = s.replace(/\*\*([^\n*]+?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^\n_]+?)__/g, "<b>$1</b>");
  s = s.replace(/(^|[^\w*])\*([^\s*][^*\n]*?)\*(?=$|[^\w*])/g, "$1<i>$2</i>");
  s = s.replace(/~~([^~\n]+?)~~/g, "<s>$1</s>");
  s = s.replace(/`([^`\n]+)`/g, (_, body: string) => `<code>${htmlEscape(body)}</code>`);
  return s;
}

function htmlEscape(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;"));
}

// For attribute values — same as htmlEscape plus the quote char. Used for
// the `class="language-…"` attribute on code blocks.
function attrEscape(s: string): string {
  return htmlEscape(s).replace(/"/g, "&quot;");
}
