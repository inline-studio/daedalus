// SEC-10: brain front-matter must be parsed as YAML only. gray-matter's default `javascript`
// engine evaluates `---js` front-matter via eval(); parseFrontmatter disables it so a brain
// file can't execute code at load time. Normal YAML front-matter must still parse correctly.

import { parseFrontmatter } from "../dist/brain/frontmatter.js";

let pass = true;
const expect = (label, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${label}${detail ? " — " + detail : ""}`);
  if (!ok) pass = false;
};

// 1. Normal YAML front-matter parses to data + body.
{
  const text = "---\ndescription: hello\naliases: [a, b]\n---\nThe body.\n";
  const fm = parseFrontmatter(text);
  expect("YAML data parsed", fm.data && fm.data.description === "hello");
  expect("YAML array parsed", Array.isArray(fm.data.aliases) && fm.data.aliases.length === 2);
  expect("body preserved", fm.content.trim() === "The body.");
}

// 2. A `---js` block must NOT execute — it must throw instead of eval'ing.
{
  globalThis.__SEC10_PWNED__ = false;
  const evil = "---js\nmodule.exports = { x: (globalThis.__SEC10_PWNED__ = true) }\n---\nbody";
  let threw = false;
  try {
    parseFrontmatter(evil);
  } catch {
    threw = true;
  }
  expect("---js front-matter throws (not eval'd)", threw);
  expect("eval side-effect did NOT run", globalThis.__SEC10_PWNED__ === false);
}

// 3. A body-only file (no front-matter) still works.
{
  const fm = parseFrontmatter("just a body, no frontmatter\n");
  expect("body-only file parses", fm.content.trim() === "just a body, no frontmatter");
}

console.log(`\nresult: ${pass ? "PASS" : "FAIL"}`);
process.exit(pass ? 0 : 1);
