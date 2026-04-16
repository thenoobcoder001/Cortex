const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getConfig: () => ipcRenderer.invoke("desktop:get-config"),
  setRemoteAccess: (enabled) => ipcRenderer.invoke("desktop:set-remote-access", { enabled }),
  pickRepoDirectory: () => ipcRenderer.invoke("desktop:pick-repo"),
  openInEditor: (editor, repoRoot) =>
    ipcRenderer.invoke("desktop:open-in-editor", { editor, repoRoot }),
  openFile: (filePath) => ipcRenderer.invoke("desktop:open-file", { path: filePath }),
});
