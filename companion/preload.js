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
  pttPcm: (arrayBuffer) => ipcRenderer.send('companion:ptt:pcm', arrayBuffer),
  systemPcm: (arrayBuffer) => ipcRenderer.send('companion:system:pcm', arrayBuffer),
  setIgnoreMouse: (v) => ipcRenderer.send('companion:mouse:ignore', v),
  // The Knot strand: guide sessions, dismissal, consent, corner.
  guideAsk: (payload) => ipcRenderer.send('companion:guide:ask', payload),
  guideDismiss: (reason) => ipcRenderer.send('companion:guide:dismiss', { reason: String(reason || '') }),
  guideKeep: (sessionId) => ipcRenderer.send('companion:guide:keep', { sessionId }),
  guideSkip: (sessionId) => ipcRenderer.send('companion:guide:skip', { sessionId }),
  strandArrived: () => ipcRenderer.send('companion:strand:arrived'),
  knotCornerSet: (corner) => ipcRenderer.invoke('companion:knot:corner:set', corner),
  openPane: (url) => ipcRenderer.send('companion:open-pane', url),
  log: (msg) => ipcRenderer.send('companion:log', msg),
  on: (channel, cb) => {
    const allowed = ['capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'llm:busy', 'status', 'transcript', 'spar:state', 'cursor:probe', 'knot:set', 'tour:start', 'daily:line', 'capture:limit',
      'guide:state', 'guide:target', 'guide:bubble', 'guide:done', 'guide:hint', 'knot:corner', 'ptt:state', 'quick:open'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
