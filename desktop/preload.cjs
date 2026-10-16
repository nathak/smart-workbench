// The only things the status window may call: read the overview and send a contract change. No Node, no other channel.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('swb', {
  overview: () => ipcRenderer.invoke('swb:overview'),
  send: (session, ops) => ipcRenderer.invoke('swb:send', session, ops),
})
