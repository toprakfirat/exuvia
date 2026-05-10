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
    transcribe: (args) => ipcRenderer.invoke("exuvia:audio:transcribe", args),
  },
  openclaw: {
    audioProviders: () => ipcRenderer.invoke("exuvia:openclaw:audioProviders"),
    authSet: (args) => ipcRenderer.invoke("exuvia:openclaw:authSet", args),
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
  hotkey: {
    getToggle: () => ipcRenderer.invoke("exuvia:hotkey:getToggle"),
    setToggle: (accelerator) => ipcRenderer.invoke("exuvia:hotkey:setToggle", accelerator),
  },
  tray: {
    setIcon: (sourcePath) => ipcRenderer.invoke("exuvia:tray:setIcon", sourcePath),
    resetIcon: () => ipcRenderer.invoke("exuvia:tray:resetIcon"),
    getIconInfo: () => ipcRenderer.invoke("exuvia:tray:getIconInfo"),
  },
  plugin: {
    status: () => ipcRenderer.invoke("exuvia:plugin:status"),
    install: () => ipcRenderer.invoke("exuvia:plugin:install"),
  },
  dialog: {
    openFile: (opts) => ipcRenderer.invoke("exuvia:dialog:openFile", opts),
    openTextFile: (opts) => ipcRenderer.invoke("exuvia:dialog:openTextFile", opts),
    saveTextFile: (args) => ipcRenderer.invoke("exuvia:dialog:saveTextFile", args),
  },
});
