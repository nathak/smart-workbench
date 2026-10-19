// The only thing the main window's page may call: open the status window. No arguments, no other channel, and not the status window's own preload.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('swbApp', {
  openStatus: () => ipcRenderer.invoke('swb:open-status'),
})
