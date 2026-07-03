# Daedalus Desktop

A thin Electron shell around the daedalus **web UI**. The supervisor keeps running
wherever it lives (your server); this app is a native window on the web channel plus the
integration a browser tab can't give you:

- **Native notifications** — the UI's existing 🔔 opt-in maps to real macOS/Linux
  notifications.
- **Dock badge** — unread replies count onto the app icon while the window is in the
  background; cleared on focus.
- **Persistent login** — the web channel's login cookie lives in the app's own session,
  so you sign in once.
- **External links** open in your default browser, never in-app.
- macOS: hidden title bar with the traffic lights floating over the sidebar (the web UI
  detects the shell and pads for them).

No daedalus code runs in this process — if the web UI works at your server URL in a
browser, it works here.

## Run (dev)

```bash
cd apps/desktop
npm install
npm start
```

First launch asks for your server URL — the same address you'd open in a browser (your
proxy, or `http://127.0.0.1:8765` for a local stack). Change it later via
**Server → Change Server…** in the app menu.

`npm run smoke` boots the app headlessly-ish and, when a server is configured, verifies
the page loads and the preload bridge is exposed, then exits.

## Package

```bash
npm run dist   # electron-builder → dmg (mac, arm64+x64) / AppImage (linux)
```

Unsigned by default. For a signed, notarised mac build (required for distribution beyond
your own machine), add Apple credentials per the electron-builder docs. Auto-update is
not wired yet — it needs a signed build + a release feed; planned alongside the CI
release pipeline.

## How it talks to the web UI

`preload.js` exposes exactly one page-facing API:

```js
window.daedalusDesktop = { platform, setBadge(count) }
```

The web UI (`src/web/ui/app.js`) feature-detects it: dock-badge unread counting and the
macOS traffic-light inset activate only inside the shell, so the same served page keeps
working unchanged in ordinary browsers.
