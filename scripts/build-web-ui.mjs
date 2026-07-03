// Assemble the web chat UI from its real source files into the generated TS module the
// channel serves. Source of truth:
//
//   src/web/ui/index.html   — the document shell (placeholder comments mark the inline slots)
//   src/web/ui/styles.css   — all CSS (inlined into <style>)
//   src/web/ui/app.js       — all client JS (inlined into the trailing <script>)
//   src/web/ui/login.html   — the login page (login auth mode)
//
// Output: src/channels/web-ui.ts (GENERATED — do not edit by hand). The strings are embedded
// via JSON.stringify, so the source files can use backticks and ${} freely — none of the
// template-literal escaping the old hand-maintained module needed.
//
// Runs as part of `npm run build` (before tsc). The generated file is committed so
// `npm run dev` / tsx work without a build step; re-run this script after editing the UI.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uiDir = path.join(root, "src", "web", "ui");
const outFile = path.join(root, "src", "channels", "web-ui.ts");

const read = (f) => fs.readFileSync(path.join(uiDir, f), "utf8");

const shell = read("index.html");
const css = read("styles.css");
const js = read("app.js");
const login = read("login.html");

for (const marker of ["/*__DAE_STYLES__*/", "/*__DAE_APP_JS__*/"]) {
  if (!shell.includes(marker)) {
    console.error(`build-web-ui: index.html is missing the ${marker} placeholder`);
    process.exit(1);
  }
}
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// Function replacers so `$`-sequences in the CSS/JS can't be misread as replacement patterns.
// __DAE_CLIENT_VERSION__ is baked in at build time — the status bar shows it next to the
// server-reported backend version, so a stale cached UI is visible at a glance.
const html = shell
  .replace("/*__DAE_STYLES__*/", () => css.trimEnd())
  .replace("/*__DAE_APP_JS__*/", () => js.trimEnd())
  .replace(/__DAE_CLIENT_VERSION__/g, () => `v${pkg.version}`);

// Server-side injection points the channel substitutes at serve time — losing one in an
// edit would silently break auth-mode detection or the transcript labels.
for (const marker of ["__DAE_WEB_MODE__", "__DAE_ASSISTANT_NAME__", "__DAE_USER_NAME__"]) {
  if (!html.includes(marker)) {
    console.error(`build-web-ui: assembled UI lost the ${marker} injection point`);
    process.exit(1);
  }
}

const banner = `// GENERATED FILE — do not edit. Built by scripts/build-web-ui.mjs from src/web/ui/
// (index.html + styles.css + app.js + login.html). Edit those and re-run
// \`node scripts/build-web-ui.mjs\` (also part of \`npm run build\`).
//
// The daedalus web chat UI — a single, zero-dependency HTML document served by the web
// channel at GET /. It talks to the same channel API the page is served from (/history,
// /messages, /events SSE, /conversations, /status). Auth modes (login / token / open) are
// injected by the server as __DAE_WEB_MODE__; see channels/web.ts renderShell().
`;

const out =
  banner +
  `\nexport const WEB_UI_HTML = ${JSON.stringify(html)};\n` +
  `\nexport const WEB_LOGIN_HTML = ${JSON.stringify(login)};\n`;

fs.writeFileSync(outFile, out);
console.log(
  `build-web-ui: wrote ${path.relative(root, outFile)} (${html.length} + ${login.length} bytes)`,
);
