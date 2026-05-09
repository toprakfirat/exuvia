/* eslint-disable */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("exuvia", {
  settings: {
    get: () => ipcRenderer.invoke("exuvia:settings:get"),
    set: (patch) => ipcRenderer.invoke("exuvia:settings:set", patch),
  },
  token: {
    get: () => ipcRenderer.invoke("exuvia:token:get"),
    set: (token) => ipcRenderer.invoke("exuvia:token:set", token),
  },
  audio: {
    readBase64: (filePath) => ipcRenderer.invoke("exuvia:audio:readBase64", filePath),
  },
  fbx: {
    write: (args) => ipcRenderer.invoke("exuvia:fbx:write", args),
    read: (filePath) => ipcRenderer.invoke("exuvia:fbx:read", filePath),
  },
  dir: {
    remove: (dirPath) => ipcRenderer.invoke("exuvia:dir:remove", dirPath),
  },
  path: {
    expand: (raw) => ipcRenderer.invoke("exuvia:path:expand", raw),
  },
  openExternal: (url) => ipcRenderer.invoke("exuvia:openExternal", url),
  dialog: {
    openFile: (opts) => ipcRenderer.invoke("exuvia:dialog:openFile", opts),
  },
});
