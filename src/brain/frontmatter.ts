import matter from "gray-matter";

// SEC-10: gray-matter's default `javascript` engine runs `---js` / `lang: js` front-matter
// through eval() (node_modules/gray-matter/lib/engines.js). Brain files (agents, skills,
// commands) are parsed at load time, so a `---js` block would execute arbitrary code
// in-process. Brain front-matter is always YAML, so we replace the JS engine with one that
// throws — closing the eval path while leaving normal YAML parsing untouched. The `js` and
// `javascript` delimiters both normalise to `javascript` (gray-matter/lib/engine.js), so
// overriding that key is what disables it; `js` is included defensively.
const refuseJs = (): never => {
  throw new Error("JS front-matter (---js) is disabled for security; use YAML front-matter.");
};

export function parseFrontmatter(text: string): matter.GrayMatterFile<string> {
  return matter(text, {
    language: "yaml",
    engines: { javascript: refuseJs, js: refuseJs },
  });
}
