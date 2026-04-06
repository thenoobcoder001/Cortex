const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopApi", {
  getConfig: () => ipcRenderer.invoke("desktop:get-config"),
  pickRepoDirectory: () => ipcRenderer.invoke("desktop:pick-repo"),
});
