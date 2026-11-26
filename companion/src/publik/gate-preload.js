'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('publikGate', {
  onScreen: (fn) => ipcRenderer.on('publik-gate:screen', (_e, v) => fn(v)),
  press: (action) => ipcRenderer.send('publik-gate:press', String(action)),
  // A click or key anywhere in the window: it no longer needs to stay on top.
  touch: () => ipcRenderer.send('publik-gate:touch'),
});
