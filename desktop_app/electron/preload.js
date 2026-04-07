const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getConfig: () => ipcRenderer.invoke("desktop:get-config"),
  pickRepoDirectory: () => ipcRenderer.invoke("desktop:pick-repo"),
  openInEditor: (editor, repoRoot) =>
    ipcRenderer.invoke("desktop:open-in-editor", { editor, repoRoot }),
});
