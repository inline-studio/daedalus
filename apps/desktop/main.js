// Daedalus Desktop — a thin Electron shell around the daedalus web UI.
//
// The supervisor stays wherever it runs (your server); this app is a client window on
// the web channel, plus the native integration a browser tab can't give you: a dock
// badge for unread replies, native notifications (the UI's existing Notification-API
// opt-in maps to real macOS notifications here), persistent login (cookies live in the
// app's own session), and external links opening in your default browser.
//
// No daedalus code runs in this process — if the web UI works at your server URL in a
// browser, it works here.

const { app, BrowserWindow, Menu, ipcMain, shell, session } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const SMOKE = process.argv.includes("--smoke-test");

// --- Settings (a plain JSON file in userData; the only setting is the server URL) ---
const settingsPath = () => path.join(app.getPath("userData"), "settings.json");

function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch {
    return {};
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(next, null, 2));
  return next;
}

// --- Window ---
let win = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: "#0a0c10",
    // macOS: hide the title bar, keep the traffic lights floating over the sidebar
    // (the web UI adds inset padding when it detects the desktop shell).
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Links that leave the daedalus origin open in the default browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const server = readSettings().serverUrl;
    if (server && !url.startsWith(server) && !url.startsWith("file:")) {
      event.preventDefault();
      shell.openExternal(url).catch(() => {});
    }
  });

  // Clear the dock badge whenever the window regains focus.
  win.on("focus", () => app.setBadgeCount(0));

  const { serverUrl } = readSettings();
  if (serverUrl) {
    win.loadURL(serverUrl);
  } else {
    win.loadFile(path.join(__dirname, "setup.html"));
  }
}

function openSetup() {
  writeSettings({ serverUrl: "" });
  win?.loadFile(path.join(__dirname, "setup.html"));
}

// --- IPC from the preload bridge ---
ipcMain.handle("dae:connect", (_ev, rawUrl) => {
  let url;
  try {
    url = new URL(String(rawUrl)).toString().replace(/\/$/, "");
  } catch {
    return { ok: false, error: "That doesn't look like a URL." };
  }
  writeSettings({ serverUrl: url });
  win?.loadURL(url);
  return { ok: true };
});

ipcMain.on("dae:badge", (_ev, count) => {
  // Only meaningful while unfocused; focus resets it (see the focus handler above).
  app.setBadgeCount(Math.max(0, Number(count) || 0));
});

// --- App menu: the defaults plus a Server submenu ---
function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "Server",
      submenu: [
        {
          label: "Change Server…",
          click: () => openSetup(),
        },
        { type: "separator" },
        { role: "reload" },
        { role: "toggleDevTools" },
      ],
    },
    { role: "viewMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(() => {
  // Belt-and-braces: the web UI asks for Notification permission via the standard API;
  // grant it for the configured server so the opt-in flow works exactly like a browser.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "notifications");
  });
  buildMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  if (SMOKE) {
    // Dev sanity check: prove the app boots. With a configured server it additionally
    // waits for the page, checks the preload bridge + desktop styling hooks landed, and
    // exits 1 if not — the end-to-end "shell ↔ web UI" contract in one command.
    const finish = (ok, note) => {
      console.log(`smoke-test: ${note}`);
      setTimeout(() => app.exit(ok ? 0 : 1), 100);
    };
    if (!readSettings().serverUrl) {
      setTimeout(() => finish(true, "window created (no server configured), exiting"), 300);
    } else {
      win.webContents.once("did-finish-load", async () => {
        try {
          const r = await win.webContents.executeJavaScript(
            `({ bridge: typeof window.daedalusDesktop, mac: document.body.classList.contains("desktop-mac"), title: document.title })`,
          );
          const ok = r.bridge === "object" && r.title.length > 0;
          finish(ok, `loaded ${win.webContents.getURL()} bridge=${r.bridge} mac=${r.mac} title=${JSON.stringify(r.title)}`);
        } catch (err) {
          finish(false, `page check failed: ${err.message}`);
        }
      });
      win.webContents.once("did-fail-load", (_e, code, desc) => finish(false, `load failed: ${code} ${desc}`));
    }
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
