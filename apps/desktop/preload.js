// Context bridge between the daedalus web UI and the desktop shell. Everything is
// deliberately tiny and one-way: the page can set the dock badge and read the platform;
// the setup page can save a server URL. No node APIs leak into the page.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("daedalusDesktop", {
  platform: process.platform,
  // Dock/taskbar unread badge. The shell clears it automatically on window focus.
  setBadge: (count) => ipcRenderer.send("dae:badge", count),
  // This app's executor id (null when local execution is off) — the page sends it with
  // messages so ⌁ local turns run on THIS machine, not whichever connected last.
  executorId: () => ipcRenderer.invoke("dae:executor-id"),
});

// Only used by setup.html (the first-run setup page); harmless to expose everywhere
// since it just round-trips to the settings file + loads the URL.
contextBridge.exposeInMainWorld("daedalusSetup", {
  // Current settings + defaults, so re-opening setup prefills instead of starting over.
  state: () => ipcRenderer.invoke("dae:setup-state"),
  // Native directory picker for the workspace field.
  pickWorkspace: (current) => ipcRenderer.invoke("dae:pick-workspace", current),
  // Submit everything at once: { url, executor: { enabled, approval, workspace } }.
  connect: (payload) => ipcRenderer.invoke("dae:connect", payload),
});
