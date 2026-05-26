// Smoke for the Telegram markdown -> HTML converter (channels/format/telegram-html.ts).
//
// The bug: telegram.ts was sending Claude's raw `**bold**` text with no parse_mode,
// so users saw the asterisks literally. The fix translates the common Markdown
// subset into Telegram's restricted HTML dialect.
//
// What's covered here:
//   1. The bug report itself — the exact message Scott pasted renders bolds.
//   2. Each supported transformation in isolation: **bold**, __bold__, *italic*,
//      ~~strike~~, [link](url), `code`, ```fence```.
//   3. Order: bold runs before italic (so `**x**` doesn't collapse to `<b>*x*</b>` or worse).
//   4. Negative space — things we deliberately DON'T transform: list markers
//      (`* item`), underscores in identifiers (`some_var_name`), nested asterisks
//      mid-word (`var*name*ing`).
//   5. HTML escaping: `<`, `>`, `&` get escaped in the body but bold/italic
//      tag output still produces valid HTML.
//   6. Code blocks: their contents are escaped + tagged correctly and do NOT
//      get markdown-processed (so `**` inside code stays literal).
//   7. The plain-text fallback strips all markers cleanly.

import { markdownToTelegramHtml, stripMarkdownForPlain } from "../dist/channels/format/telegram-html.js";

let pass = true;
const eq = (label, got, want) => {
  const ok = got === want;
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) {
    console.log(`     got:  ${JSON.stringify(got)}`);
    console.log(`     want: ${JSON.stringify(want)}`);
    pass = false;
  }
};
const contains = (label, got, needle) => {
  const ok = got.includes(needle);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) {
    console.log(`     got: ${JSON.stringify(got)}`);
    console.log(`     missing: ${JSON.stringify(needle)}`);
    pass = false;
  }
};
const notContains = (label, got, needle) => {
  const ok = !got.includes(needle);
  console.log(`${ok ? "✓" : "✗"} ${label}`);
  if (!ok) {
    console.log(`     got: ${JSON.stringify(got)}`);
    console.log(`     forbidden substring: ${JSON.stringify(needle)}`);
    pass = false;
  }
};

// ─── 1. the bug report — Scott's exact message ───────────────────────────────
{
  const msg =
    "The **living room temperature** is currently **25.8°C**, with the target set to **10°C** (likely in frost-protection or off mode).\n\nWould you like me to adjust the temperature?";
  const out = markdownToTelegramHtml(msg);
  contains("bold renders for 'living room temperature'", out, "<b>living room temperature</b>");
  contains("bold renders for '25.8°C'", out, "<b>25.8°C</b>");
  contains("bold renders for '10°C'", out, "<b>10°C</b>");
  notContains("no literal `**` survives in the output", out, "**");
  contains("paragraph text outside bold is preserved verbatim", out, "currently ");
  contains("trailing question is preserved", out, "Would you like me to adjust the temperature?");
}

// ─── 2. each supported transformation in isolation ───────────────────────────
eq("**bold** -> <b>", markdownToTelegramHtml("a **b** c"), "a <b>b</b> c");
eq("__bold__ -> <b>", markdownToTelegramHtml("a __b__ c"), "a <b>b</b> c");
eq("*italic* -> <i>", markdownToTelegramHtml("a *b* c"), "a <i>b</i> c");
eq("~~strike~~ -> <s>", markdownToTelegramHtml("a ~~b~~ c"), "a <s>b</s> c");
eq("[label](url) -> <a>", markdownToTelegramHtml("see [docs](https://x.com/d)"), 'see <a href="https://x.com/d">docs</a>');
eq("`inline code` -> <code>", markdownToTelegramHtml("use `cd /tmp`"), "use <code>cd /tmp</code>");

// ─── 3. order — bold before italic ───────────────────────────────────────────
eq("**x** stays bold, not <b>*x*</b>", markdownToTelegramHtml("**x**"), "<b>x</b>");
// `***both***` should be bold+italic; either nesting order is valid Telegram HTML
// and renders identically. Assert structurally rather than pinning the exact order.
{
  const out = markdownToTelegramHtml("***both***");
  contains("***both*** wraps text in <b>", out, "<b>");
  contains("***both*** wraps text in <i>", out, "<i>");
  contains("***both*** preserves 'both'", out, ">both<");
  notContains("***both*** drops surrounding asterisks", out, "*");
}

// ─── 4. negative space — markers we deliberately leave alone ────────────────
notContains(
  "'* item' (list marker) does NOT open italic",
  markdownToTelegramHtml("here's a list:\n* one\n* two"),
  "<i>",
);
eq(
  "underscores in identifier 'some_var_name' stay literal",
  markdownToTelegramHtml("call `some_var_name`"),
  "call <code>some_var_name</code>",
);
notContains(
  "'var*name*ing' (asterisk mid-word) does NOT open italic",
  markdownToTelegramHtml("var*name*ing"),
  "<i>",
);

// ─── 5. HTML escaping ────────────────────────────────────────────────────────
eq(
  "literal < > & are escaped outside formatting",
  markdownToTelegramHtml("if a < b && c > d"),
  "if a &lt; b &amp;&amp; c &gt; d",
);
eq(
  "escaping survives alongside formatting",
  markdownToTelegramHtml("**A < B**"),
  "<b>A &lt; B</b>",
);

// ─── 6. code blocks — body escaped, no inner markdown processing ────────────
{
  const out = markdownToTelegramHtml("```\nif a < b && **not bold**\n```");
  contains("triple-backtick wraps in <pre>", out, "<pre>");
  contains("body is HTML-escaped", out, "if a &lt; b &amp;&amp;");
  contains("body keeps literal ** (no bold pass inside)", out, "**not bold**");
}
{
  const out = markdownToTelegramHtml("```python\nprint('hi')\n```");
  contains("language hint becomes class attribute", out, '<pre><code class="language-python">');
}

// ─── 7. plain-text fallback ──────────────────────────────────────────────────
eq(
  "plain-text fallback strips all markers",
  stripMarkdownForPlain("The **temp** is *now* `25C` — see [docs](https://x)"),
  "The temp is now 25C — see docs",
);

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
