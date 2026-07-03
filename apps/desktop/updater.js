// Update checking, two tiers:
//
//   1. electron-updater against the GitHub Releases feed — downloads and applies in
//      place. Works on Linux (AppImage) as-is and on macOS ONCE BUILDS ARE SIGNED:
//      Squirrel.Mac validates the app's code signature before applying an update, so an
//      unsigned mac build cannot self-update (electron-builder: "macOS application must
//      be signed in order for auto updating to work").
//
//   2. Fallback for exactly that unsigned-mac case (and any feed error): ask the GitHub
//      releases API for the newest desktop release and open its page for a manual
//      download — the closest an unsigned build can get, honestly labelled.
//
// Both run from Server → Check for Updates…; tier 1 also runs quietly at launch for
// packaged builds.

const { app, dialog, shell } = require("electron");

const REPO = { owner: "inline-studio", repo: "daedalus" };
// Desktop releases are tagged desktop-v<version> so they don't collide with the daedalus
// server's own v0.1.0-<run> release tags in the same repo.
const TAG_PREFIX = "desktop-v";

let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch {
  /* dependency missing in a stripped build — manual tier still works */
}

function wireAutoUpdater() {
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.on("update-downloaded", (info) => {
    dialog
      .showMessageBox({
        type: "info",
        message: `Daedalus ${info.version} is ready`,
        detail: "The update has been downloaded. Restart to apply it.",
        buttons: ["Restart now", "Later"],
        defaultId: 0,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });
}

// Manual tier: newest desktop-v* release from the GitHub API. Returns null when up to
// date or unreachable.
async function findNewerRelease() {
  const res = await fetch(
    `https://api.github.com/repos/${REPO.owner}/${REPO.repo}/releases?per_page=30`,
    { headers: { accept: "application/vnd.github+json" } },
  );
  if (!res.ok) throw new Error(`GitHub API ${res.status}`);
  const releases = await res.json();
  const desktop = releases.find((r) => typeof r.tag_name === "string" && r.tag_name.startsWith(TAG_PREFIX));
  if (!desktop) return null;
  const latest = desktop.tag_name.slice(TAG_PREFIX.length);
  return isNewer(latest, app.getVersion()) ? { version: latest, url: desktop.html_url } : null;
}

// Dotted-numeric compare, good enough for our x.y.z tags (pre-release suffixes compare
// as older than their release).
function isNewer(a, b) {
  const pa = String(a).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  }
  return false;
}

async function manualCheck({ silent } = {}) {
  try {
    const newer = await findNewerRelease();
    if (!newer) {
      if (!silent) {
        dialog.showMessageBox({ type: "info", message: "You're up to date", detail: `Daedalus ${app.getVersion()}` });
      }
      return;
    }
    const { response } = await dialog.showMessageBox({
      type: "info",
      message: `Daedalus ${newer.version} is available`,
      detail:
        "This build can't update itself in place (unsigned macOS builds can't — the OS " +
        "requires a code signature to apply updates). Download it from GitHub instead.",
      buttons: ["Open download page", "Later"],
      defaultId: 0,
    });
    if (response === 0) shell.openExternal(newer.url).catch(() => {});
  } catch (err) {
    if (!silent) {
      dialog.showMessageBox({ type: "warning", message: "Update check failed", detail: String(err.message || err) });
    }
  }
}

// Public: quiet check at launch (packaged builds only — electron-updater refuses dev
// runs), and the menu-invoked explicit check.
function checkAtLaunch() {
  if (!app.isPackaged) return;
  if (autoUpdater) {
    wireAutoUpdater();
    autoUpdater.checkForUpdates().catch(() => manualCheck({ silent: true }));
  } else {
    manualCheck({ silent: true });
  }
}

function checkFromMenu() {
  if (app.isPackaged && autoUpdater) {
    wireAutoUpdater();
    autoUpdater
      .checkForUpdates()
      .then((r) => {
        if (!r || !r.updateInfo || !isNewer(r.updateInfo.version, app.getVersion())) {
          dialog.showMessageBox({ type: "info", message: "You're up to date", detail: `Daedalus ${app.getVersion()}` });
        }
        // A newer version continues through autoDownload → the update-downloaded dialog.
      })
      .catch(() => manualCheck({ silent: false }));
  } else {
    manualCheck({ silent: false });
  }
}

module.exports = { checkAtLaunch, checkFromMenu };
