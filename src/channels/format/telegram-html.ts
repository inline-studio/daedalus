// Convert Claude's CommonMark output into the limited HTML dialect Telegram
// accepts, so `**bold**` lands as actual bold instead of literal asterisks.
//
// Why HTML and not MarkdownV2: Telegram's MarkdownV2 demands every special
// character (`_*[]()~>#+-=|{}.!`) be escaped outside formatting context, and
// one missed escape returns HTTP 400 — the whole message fails to send. HTML
// only requires escaping `<`, `>`, `&`. Far safer.
//
// Supported transformations (best-effort; anything not covered survives as
// plain text):
//   - `**x**` / `__x__`          -> <b>x</b>
//   - `*x*`                      -> <i>x</i>     (single underscore italic
//                                                  intentionally NOT mapped —
//                                                  too noisy with identifiers
//                                                  like `some_var_name`)
//   - `~~x~~`                    -> <s>x</s>
//   - `[label](url)`             -> <a href="url">label</a>
//   - `` `code` ``               -> <code>code</code>
//   - triple-backtick blocks     -> <pre>…</pre>  (with optional language hint)
//
// Headings, lists, blockquotes, tables stay as plain text — Telegram doesn't
// render them anyway, and rewriting structure breaks the model's intent more
// than it helps.
//
// Order matters:
//   1. extract triple-backtick + inline code into placeholders (so their
//      bodies don't get mangled by the formatting passes)
//   2. HTML-escape EVERYTHING else
//   3. apply bold (`**`) BEFORE italic (`*`) — otherwise the italic regex
//      eats the bold delimiters
//   4. re-insert the escaped code blocks

// Printable sentinel for code-block placeholders. Chosen because the
// combination is vanishingly unlikely to appear in a real assistant reply,
// is plain ASCII (so htmlEscape leaves it alone), and is visible if you
// ever have to debug the output mid-pipeline.
const PH_OPEN = "␂DAE␂"; // U+2402 SYMBOL FOR START OF TEXT
const PH_CLOSE = "␃DAE␃"; // U+2403 SYMBOL FOR END OF TEXT

export function markdownToTelegramHtml(md: string): string {
  if (!md) return "";

  // 1a. Triple-backtick blocks. Optional language tag on the opening fence.
  //     We capture the body verbatim — htmlEscape happens when we re-emit.
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

  // 1b. Inline code.
  const inline: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, body: string) => {
    const idx = inline.length;
    inline.push(`<code>${htmlEscape(body)}</code>`);
    return `${PH_OPEN}IC${idx}${PH_CLOSE}`;
  });

  // 2. Escape the rest. The PH_* sentinels are plain ASCII so they survive
  //    htmlEscape unchanged.
  s = htmlEscape(s);

  // 3. Formatting passes. Bold FIRST so its `**` delimiters are gone before
  //    the italic pass runs. Non-greedy and disallowing the delimiter char
  //    inside the captured body to keep boundaries unambiguous.
  s = s.replace(/\*\*([^\n*][\s\S]*?)\*\*/g, "<b>$1</b>");
  s = s.replace(/__([^\n_][\s\S]*?)__/g, "<b>$1</b>");
  // Italic: require the opening `*` to be at start-of-line or preceded by a
  // non-word/non-asterisk char, and the closing `*` to be followed by the
  // same, so `* item` (list marker) and `var*name` (identifier middle) don't
  // accidentally start an italic run.
  s = s.replace(/(^|[^\w*])\*([^\s*][^*\n]*?)\*(?=$|[^\w*])/g, "$1<i>$2</i>");
  s = s.replace(/~~([\s\S]+?)~~/g, "<s>$1</s>");

  // Links last — the URL captured here was htmlEscape'd in step 2, which
  // means `&` already became `&amp;`. That's correct for inserting into an
  // href attribute.
  s = s.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
    return `<a href="${url}">${label}</a>`;
  });

  // 4. Restore code placeholders.
  s = s.replace(
    new RegExp(`${PH_OPEN}CB(\\d+)${PH_CLOSE}`, "g"),
    (_, n: string) => codeBlocks[Number(n)] ?? "",
  );
  s = s.replace(
    new RegExp(`${PH_OPEN}IC(\\d+)${PH_CLOSE}`, "g"),
    (_, n: string) => inline[Number(n)] ?? "",
  );

  return s;
}

// Strip markdown markers for plain-text fallback (when Telegram rejects HTML
// — a defensive belt for malformed input we couldn't sanitize). Removes the
// syntactic noise — emphasis tokens, link brackets — without trying to
// preserve any styling.
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
  // Inline code: keep the body, drop the backticks.
  s = s.replace(/`([^`\n]+)`/g, "$1");
  // Code fences: keep the body, drop the fence + language tag.
  s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, "$1");
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
