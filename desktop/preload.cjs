const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("studioDesktop", {
  openDataFolder: () => ipcRenderer.invoke("studio:open-data-folder"),
});
