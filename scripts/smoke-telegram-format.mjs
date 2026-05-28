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

// ─── 8. headings — # through ###### collapse to bold on their own line ──────
{
  eq("'# Heading' -> <b>", markdownToTelegramHtml("# Heading"), "<b>Heading</b>");
  eq("'## H2' -> <b>", markdownToTelegramHtml("## H2"), "<b>H2</b>");
  eq("'### H3' -> <b>", markdownToTelegramHtml("### H3"), "<b>H3</b>");
  eq("'###### H6' -> <b>", markdownToTelegramHtml("###### H6"), "<b>H6</b>");
  // Atx-style closing hashes get stripped.
  eq("'## Heading ##' -> <b> (closing hashes stripped)", markdownToTelegramHtml("## Heading ##"), "<b>Heading</b>");
  // A # in the middle of a line is NOT a heading.
  contains("'foo # bar' is not a heading", markdownToTelegramHtml("foo # bar"), "foo # bar");
  notContains("'foo # bar' doesn't get bolded", markdownToTelegramHtml("foo # bar"), "<b>");
  // Heading in a multi-paragraph message keeps surrounding structure.
  {
    const out = markdownToTelegramHtml("Intro line.\n\n### My heading\n\nNext paragraph.");
    contains("heading in context: bolded", out, "<b>My heading</b>");
    contains("heading in context: prior text preserved", out, "Intro line.");
    contains("heading in context: following text preserved", out, "Next paragraph.");
  }
  // Plain-text fallback also de-hashes.
  eq("plain-text fallback strips heading hashes", stripMarkdownForPlain("## Heading"), "Heading");
}

// ─── 9. lists — `- ` / `* ` line-starts become bullets ──────────────────────
{
  const out = markdownToTelegramHtml("Pros:\n- One\n- Two\n- Three");
  contains("- bullets become •", out, "• One");
  contains("subsequent bullets too", out, "• Two\n• Three");
  notContains("no '- ' line-start markers remain", out, "\n- ");

  const out2 = markdownToTelegramHtml("* alpha\n* beta");
  contains("'* ' bullets also become •", out2, "• alpha");
  contains("'* ' bullets second line", out2, "• beta");

  // List items can still contain inline emphasis.
  const out3 = markdownToTelegramHtml("- **Quality**: IP moat\n- *Growth*: 5+ years");
  contains("bullet + bold inside", out3, "• <b>Quality</b>: IP moat");
  contains("bullet + italic inside", out3, "• <i>Growth</i>: 5+ years");

  // Plain-text fallback also bulletifies.
  eq("plain-text fallback uses •", stripMarkdownForPlain("- one\n- two"), "• one\n• two");
}

// ─── 10. GFM tables — per-row stanza, NOT raw pipes ─────────────────────────
{
  // The exact bug from Scott's screenshot: a stock-comparison table arrived
  // at the user as a wall of `|` characters. After the fix it should render
  // as bold row labels with italic "header: value" lines under each.
  const tableMd = [
    "| Stock | Yield | P/E | Dividend Stability |",
    "|-------|-------|-----|--------------------|",
    "| **Games Workshop** | ~3.2% | ~38 | ✓ Growing (5+ years) |",
    "| BP | ~6.2% | ~8 | ⚠ Volatile |",
  ].join("\n");
  const out = markdownToTelegramHtml(tableMd);
  notContains("no literal `| Stock` row leaks through", out, "| Stock |");
  notContains("no separator `|---|` row leaks through", out, "|---");
  contains("first column becomes bold row label", out, "<b>Games Workshop</b>");
  contains("subsequent columns become 'Header: value'", out, "<i>Yield</i>: ~3.2%");
  contains("emoji content survives", out, "✓ Growing (5+ years)");
  contains("second row label is bold too", out, "<b>BP</b>");
  contains("second row's value is rendered", out, "<i>Dividend Stability</i>: ⚠ Volatile");
  // The bold INSIDE the first cell (`**Games Workshop**`) — formatCell
  // re-applies inline emphasis per-cell, so it survives.
  contains(
    "inline markdown inside cells is honoured",
    markdownToTelegramHtml("| A | B |\n|---|---|\n| **bold** | plain |"),
    "<b>bold</b>",
  );
  // First-column cell that's ALREADY `**bold**` shouldn't double-wrap —
  // `<b><b>X</b></b>` renders fine but is redundant noise.
  {
    const out = markdownToTelegramHtml("| A | B |\n|---|---|\n| **X** | y |");
    notContains("first-column '**X**' doesn't become '<b><b>X</b></b>'", out, "<b><b>");
    contains("first-column '**X**' still ends up bolded once", out, "<b>X</b>");
  }

  // Prose immediately after a table (no blank line) is permissive: the table
  // regex stops at the first non-pipe line, so the table renders AND the
  // prose follows as its own paragraph. Better than failing the whole block.
  const mixed = "| a | b |\n|---|---|\n| 1 | 2 |\nrandom prose";
  const mixedOut = markdownToTelegramHtml(mixed);
  contains("table portion renders when followed by prose", mixedOut, "<b>1</b>");
  contains("trailing prose is NOT silently dropped", mixedOut, "random prose");

  // Surrounding text is preserved.
  {
    const surround = "Here are the results:\n\n| col | val |\n|-----|-----|\n| a | 1 |\n\nDone.";
    const o = markdownToTelegramHtml(surround);
    contains("text before the table is kept", o, "Here are the results:");
    contains("text after the table is kept", o, "Done.");
    contains("table row is rendered", o, "<b>a</b>");
  }
}

// ─── 11. blockquotes — `> text` -> <blockquote> ─────────────────────────────
{
  // Trailing/leading newlines around the <blockquote> are by design — they
  // keep the quote visually separated from surrounding paragraphs.
  contains(
    "single-line blockquote",
    markdownToTelegramHtml("> hello"),
    "<blockquote>hello</blockquote>",
  );
  const multi = markdownToTelegramHtml("> line one\n> line two");
  contains("multi-line blockquote wraps the whole run", multi, "<blockquote>line one\nline two</blockquote>");
}

// ─── 12. integration — Scott's exact screenshot reply ───────────────────────
// Combines headings + bold + a table + a list. The before-state was raw
// `###` lines, raw pipe rows, and `-` bullets all sent to Telegram literally.
{
  const reply = [
    "You're right — Games Workshop **did pay a £1.20/share final dividend** for 2025.",
    "",
    "### Key comparison vs your current holdings:",
    "",
    "| Stock | Yield | P/E | Dividend Stability |",
    "|-------|-------|-----|--------------------|",
    "| **Games Workshop** | ~3.2% | ~38 | ✓ Growing |",
    "| BP | ~6.2% | ~8 | ⚠ Volatile |",
    "",
    "### Should you add it?",
    "",
    "**Pros:**",
    "- Quality business: IP moat",
    "- Dividend growth: 5+ years",
    "",
    "**Cons:**",
    "- Higher P/E (38)",
  ].join("\n");
  const out = markdownToTelegramHtml(reply);
  notContains("no raw `###` heading hashes leak", out, "### ");
  notContains("no raw `| Stock` row leaks", out, "| Stock |");
  notContains("no raw `- ` list bullet leaks", out, "\n- ");
  contains("intro bold preserved", out, "<b>did pay a £1.20/share final dividend</b>");
  contains("heading became bold", out, "<b>Key comparison vs your current holdings:</b>");
  contains("table row label rendered", out, "<b>Games Workshop</b>");
  contains("table column rendered", out, "<i>Yield</i>: ~3.2%");
  contains("list bullets became •", out, "• Quality business: IP moat");
  contains("second list rendered too", out, "• Higher P/E (38)");
  contains("inline bold survives in list intros", out, "<b>Pros:</b>");
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
