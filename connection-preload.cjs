const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('linka', {
  copyText(value) {
    return ipcRenderer.invoke('copy-text', String(value || ''));
  },
  openUrl(value) {
    return ipcRenderer.invoke('open-url', String(value || ''));
  },
});
