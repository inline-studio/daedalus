# Daedalus Desktop

A thin Electron shell around the daedalus **web UI**. The supervisor keeps running
wherever it lives (your server); this app is a native window on the web channel plus the
integration a browser tab can't give you:

- **Local execution** — the app can be your machine's EXECUTOR: conversations you start
  here run their commands and file edits locally, in a workspace you choose, with a
  native approval dialog per command (Allow / Always allow prefix / Deny; dangerous
  patterns always ask). First connect offers to enable it; change any time under
  **Server → Local Execution…**. Auth is borrowed from the window (login cookie or the
  web UI's token), so the executor is always the same user as your chats — and the
  allowlist/audit files are shared with `dae remote` (`~/.daedalus/`).
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
npm run dist   # electron-builder → dmg (mac, arm64+x64) / NSIS installer (windows) / AppImage (linux)
```

Unsigned by default — fine for your own machines (macOS will ask for a one-time
Privacy & Security override on first launch of a downloaded copy).

## Release & updates

Releases are built by the **Desktop** workflow (`.github/workflows/desktop.yml`)
**automatically on merge to `main`** when `apps/desktop/**` (or the workflow itself)
changed — gate first (server typecheck + CI smoke battery, desktop syntax checks, a
headless Electron boot smoke), then a three-platform build, then two releases: an
immutable `desktop-v<version>` (version `0.1.<run>` unless a manual dispatch supplies
one) and the rolling **`desktop-latest`**, which is the auto-update feed (the app uses
electron-updater's *generic* provider against it; the plain GitHub provider would scan
the repo's newest release, which is almost always a *server* release here). macOS
signing + notarisation activate automatically once the `CSC_LINK` /
`CSC_KEY_PASSWORD` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` repo
secrets exist.

How updates behave per platform:

- **Linux (AppImage), Windows (NSIS), and macOS once builds are signed:**
  electron-updater checks the GitHub feed at launch, downloads in the background, and
  offers "Restart now" — fully automatic. Windows does NOT require code signing for
  auto-update (only macOS gates on it); unsigned Windows builds just show a SmartScreen
  warning on first install. Windows signing, if ever wanted, is a separate CA
  certificate — the Apple Developer account doesn't cover it.
- **Unsigned macOS builds:** the OS blocks in-place self-update — Squirrel.Mac (the
  macOS update engine) only applies updates to code-signed apps (electron-builder:
  "macOS application must be signed in order for auto updating to work"). These builds
  fall back to checking the releases API and opening the download page when something
  newer exists. **Server → Check for Updates…** runs either path on demand.

Signing needs an Apple Developer ID certificate ($99/yr) — it buys the warning-free
first launch *and* unlocks true in-place auto-update on macOS. Drop the credentials into
CI per the electron-builder docs when ready; nothing else changes.

## How it talks to the web UI

`preload.js` exposes exactly one page-facing API:

```js
window.daedalusDesktop = { platform, setBadge(count) }
```

The web UI (`src/web/ui/app.js`) feature-detects it: dock-badge unread counting and the
macOS traffic-light inset activate only inside the shell, so the same served page keeps
working unchanged in ordinary browsers.
