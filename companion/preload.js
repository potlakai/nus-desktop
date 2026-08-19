const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Overlay-window bridge. Invoke/send channels are namespaced companion:* so
// they can never collide with the desktop window's handlers in the shared
// main process. Event channels arrive via webContents.send targeted at this
// window only, so they keep their short names.
contextBridge.exposeInMainWorld('nus', {
  setZoomLevel: (level) => webFrame.setZoomLevel(level),
  getZoomLevel: () => webFrame.getZoomLevel(),
  platform: process.platform,
  settingsGet: () => ipcRenderer.invoke('companion:settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('companion:settings:set', patch),
  shortcutAssistSet: (accelerator) => ipcRenderer.invoke('companion:shortcut:assist:set', accelerator),
  ask: (payload) => ipcRenderer.send('companion:ask', payload),
  captureToggle: () => ipcRenderer.invoke('companion:capture:toggle'),
  captureState: () => ipcRenderer.invoke('companion:capture:state'),
  packStatus: () => ipcRenderer.invoke('companion:pack:status'),
  aiReady: () => ipcRenderer.invoke('companion:ai:ready'),
  desktopTour: () => ipcRenderer.invoke('companion:desktop:tour'),
  nusContextStatus: () => ipcRenderer.invoke('companion:nus-context:status'),
  sparReset: () => ipcRenderer.invoke('companion:spar:reset'),
  deepQuery: (text) => ipcRenderer.invoke('companion:deep:query', text),
  micPcm: (arrayBuffer) => ipcRenderer.send('companion:mic:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('companion:system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('companion:mouse:ignore', v),
  openPane: (url) => ipcRenderer.send('companion:open-pane', url),
  log: (msg) => ipcRenderer.send('companion:log', msg),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'llm:busy', 'status', 'transcript', 'spar:state', 'cursor:probe', 'knot:set', 'tour:start'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
