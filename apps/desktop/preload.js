// Context bridge between the daedalus web UI and the desktop shell. Everything is
// deliberately tiny and one-way: the page can set the dock badge and read the platform;
// the setup page can save a server URL. No node APIs leak into the page.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("daedalusDesktop", {
  platform: process.platform,
  // Dock/taskbar unread badge. The shell clears it automatically on window focus.
  setBadge: (count) => ipcRenderer.send("dae:badge", count),
});

// Only used by setup.html (the first-run "where is your server?" page); harmless to
// expose everywhere since it just round-trips to the settings file + loads the URL.
contextBridge.exposeInMainWorld("daedalusSetup", {
  connect: (url) => ipcRenderer.invoke("dae:connect", url),
});
