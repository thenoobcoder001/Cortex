const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getConfig: () => ipcRenderer.invoke("desktop:get-config"),
  setRemoteAccess: (enabled) => ipcRenderer.invoke("desktop:set-remote-access", { enabled }),
  pickRepoDirectory: () => ipcRenderer.invoke("desktop:pick-repo"),
  openInEditor: (editor, repoRoot) =>
    ipcRenderer.invoke("desktop:open-in-editor", { editor, repoRoot }),
  openFile: (filePath) => ipcRenderer.invoke("desktop:open-file", { path: filePath }),
  cortexStatus: () => ipcRenderer.invoke("cortex:status"),
  cortexRefreshStatus: () => ipcRenderer.invoke("cortex:refresh-status"),
  cortexConnect: (token, deviceId, reconnectSecret) =>
    ipcRenderer.invoke("cortex:connect", { token, deviceId, reconnectSecret }),
  cortexDisconnect: () => ipcRenderer.invoke("cortex:disconnect"),
  // Auto-updater
  updaterGetStatus:   () => ipcRenderer.invoke("updater:get-status"),
  updaterCheck:       () => ipcRenderer.invoke("updater:check"),
  updaterDownload:    () => ipcRenderer.invoke("updater:download"),
  updaterInstall:     () => ipcRenderer.invoke("updater:install"),
  updaterSetFeedUrl:  (url) => ipcRenderer.invoke("updater:set-feed-url", url),
  onUpdateStatus:     (cb) => ipcRenderer.on("update:status", (_e, data) => cb(data)),
  offUpdateStatus:    (cb) => ipcRenderer.off("update:status", (_e, data) => cb(data)),
});
