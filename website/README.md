# Docs site

The friendly, illustrated Daedalus guide — published to GitHub Pages by
`.github/workflows/pages.yml` on every push that touches this folder.

- `index.html` / `style.css` — the site (self-contained, no build step).
- `img/` — real screenshots of the desktop UI + rendered CLI output.

**One-time setup:** repo Settings → Pages → Source = "GitHub Actions".
Live at https://inline-studio.github.io/daedalus/ once enabled.

Screenshots are regenerated with the capture scripts in the session scratchpad
(Playwright drives the web UI harness; CLI frames render the real production
`dashboard.ts` / `tui.ts` output). Re-capture when the UI changes materially.
