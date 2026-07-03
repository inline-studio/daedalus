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

const { app, BrowserWindow, Menu, ipcMain, shell, session, dialog } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const updater = require("./updater.js");
const executor = require("./executor.js");

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

// --- Local execution (the embedded executor) ------------------------------------------

// Executor auth is BORROWED from the window, so it is always the same user as the chat:
// the login-mode session cookie (via the cookies API — it's httpOnly, invisible to page
// JS) and/or the web UI's stored uid + token from localStorage.
async function resolveAuth() {
  const { serverUrl } = readSettings();
  const headers = {};
  let externalUserId = null;
  try {
    const cookies = await session.defaultSession.cookies.get({ url: serverUrl, name: "dae_session" });
    if (cookies.length) headers.cookie = `dae_session=${cookies[0].value}`;
  } catch {
    /* no cookie — token/open mode */
  }
  try {
    const uid = await win.webContents.executeJavaScript(`localStorage.getItem("dae_uid")`);
    const token = await win.webContents.executeJavaScript(`localStorage.getItem("dae_token")`);
    if (uid) externalUserId = String(uid);
    if (token) headers.authorization = `Bearer ${token}`;
  } catch {
    /* page not ready — the executor loop retries */
  }
  // Login mode: the cookie IS the identity; don't also send a uid (the server would
  // ignore it anyway, but keep the request unambiguous).
  if (headers.cookie) externalUserId = null;
  return { headers, externalUserId };
}

let executorState = "off";

function startExecutorIfEnabled() {
  const s = readSettings();
  if (!s.serverUrl || !s.executor?.enabled || !s.executor.workspace) {
    executor.stop();
    executorState = "off";
    buildMenu();
    return;
  }
  executor.start({
    serverUrl: s.serverUrl,
    workspace: s.executor.workspace,
    approval: s.executor.approval === "yolo" ? "yolo" : "ask",
    getAuth: resolveAuth,
    parentWindow: win,
    onState: (state) => {
      executorState = state;
      buildMenu();
    },
  });
}

// The enable flow — used by the one-time wizard prompt and the Server menu.
async function configureLocalExecution() {
  const s = readSettings();
  if (s.executor?.enabled) {
    const { response } = await dialog.showMessageBox(win, {
      type: "question",
      message: "Local execution is ON",
      detail: `Workspace: ${s.executor.workspace}\nApproval: ${s.executor.approval === "yolo" ? "free rein" : "ask each command"}`,
      buttons: ["Keep as is", "Change settings…", "Turn off"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 0) return;
    if (response === 2) {
      writeSettings({ executor: { ...s.executor, enabled: false } });
      startExecutorIfEnabled();
      return;
    }
  }
  const picked = await dialog.showOpenDialog(win, {
    title: "Choose the workspace commands will run in",
    defaultPath: s.executor?.workspace || app.getPath("home"),
    properties: ["openDirectory", "createDirectory"],
  });
  if (picked.canceled || !picked.filePaths[0]) return;
  const { response: approvalChoice } = await dialog.showMessageBox(win, {
    type: "question",
    message: "How should commands be approved?",
    detail: "Ask each time is recommended. With free rein, only dangerous commands (rm -rf, sudo, …) still ask.",
    buttons: ["Ask each time", "Free rein"],
    defaultId: 0,
    noLink: true,
  });
  writeSettings({
    executor: {
      enabled: true,
      workspace: picked.filePaths[0],
      approval: approvalChoice === 1 ? "yolo" : "ask",
    },
    executorPrompted: true,
  });
  startExecutorIfEnabled();
}

// One-time wizard step: after the first successful connect, offer local execution.
async function maybeOfferLocalExecution() {
  const s = readSettings();
  if (!s.serverUrl || s.executorPrompted || s.executor?.enabled) return;
  writeSettings({ executorPrompted: true });
  const { response } = await dialog.showMessageBox(win, {
    type: "question",
    message: "Run commands on this Mac?",
    detail:
      "When enabled, conversations you start here can execute their commands and file " +
      "edits locally (in a workspace you choose, with your approval per command) instead " +
      "of on the server. You can change this any time under Server → Local Execution.",
    buttons: ["Not now", "Enable…"],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  if (response === 1) await configureLocalExecution();
}

// --- App menu: the defaults plus a Server submenu ---
function buildMenu() {
  const execLabel =
    executorState === "connected"
      ? "Local Execution: On"
      : executorState === "reconnecting"
        ? "Local Execution: Reconnecting…"
        : "Local Execution: Off";
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
        {
          label: `${execLabel}…`,
          click: () => void configureLocalExecution(),
        },
        {
          label: "Check for Updates…",
          click: () => updater.checkFromMenu(),
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
  // "media" covers the composer's dictation mic (macOS still shows its own system
  // microphone prompt on first use).
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === "notifications" || permission === "media");
  });
  buildMenu();
  createWindow();
  // Executor lifecycle: once the server page is up (auth cookies + localStorage exist),
  // start the executor if enabled, and — once, ever — offer to enable it (the wizard's
  // second step; the first is the URL page).
  win.webContents.on("did-finish-load", () => {
    if (win.webContents.getURL().startsWith("file:")) return; // the setup page
    startExecutorIfEnabled();
    if (!SMOKE) void maybeOfferLocalExecution();
  });
  // Quiet update check at launch (packaged builds only). Signed builds — and Linux —
  // download + apply via electron-updater; unsigned mac builds fall back to a
  // GitHub-releases check surfaced only when something newer exists.
  if (!SMOKE) updater.checkAtLaunch();
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
          const s = readSettings();
          if (ok && s.executor?.enabled) {
            // Executor smoke: report the identity the executor registers as, wait for it
            // to connect, and stay alive briefly so an external check can drive
            // /rpc/exec against this very app.
            const auth = await resolveAuth();
            console.log(`smoke-test: executor uid=${auth.externalUserId ?? "cookie-user"}`);
            const started = Date.now();
            const poll = setInterval(() => {
              if (executorState === "connected") {
                clearInterval(poll);
                console.log("smoke-test: executor connected");
                setTimeout(() => finish(true, `executor smoke done (state=${executorState})`), 6000);
              } else if (Date.now() - started > 10_000) {
                clearInterval(poll);
                finish(false, `executor never connected (state=${executorState})`);
              }
            }, 200);
            return;
          }
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
