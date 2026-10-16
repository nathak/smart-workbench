// The only thing the status window may call: read the overview. No other channel, no Node.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('swb', {
  overview: () => ipcRenderer.invoke('swb:overview'),
})
