const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cacamba', {
  getSources: () => ipcRenderer.invoke('screen:sources'),
  selectSource: (sel) => ipcRenderer.invoke('screen:select', sel),
  version: () => ipcRenderer.invoke('app:version'),
  openExternal: (url) => ipcRenderer.invoke('app:open', url),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  updateState: () => ipcRenderer.invoke('update:state'),
  setFullscreen: (on) => ipcRenderer.invoke('win:fullscreen', on),
  onFullscreen: (cb) => ipcRenderer.on('fullscreen', (_e, on) => cb(on)),
  onShortcut: (cb) => ipcRenderer.on('shortcut', (_e, name) => cb(name)),
  onUpdate: (cb) => ipcRenderer.on('update', (_e, info) => cb(info)),
  platform: process.platform,
});
