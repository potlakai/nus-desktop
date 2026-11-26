const { contextBridge, ipcRenderer } = require('electron');

// The touch pad's one way out: what a finger did, to main (companion/src/touch-pad.js).
contextBridge.exposeInMainWorld('touchPad', {
  send: (ev) => ipcRenderer.send('companion:touchpad:event', ev),
});
