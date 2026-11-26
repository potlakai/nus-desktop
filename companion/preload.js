const { contextBridge, ipcRenderer, webFrame, webUtils } = require('electron');

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
  // Standalone: the one settings surface is the Nūs Companion window.
  openSettings: (section) => ipcRenderer.invoke('companion:settings:open', section == null ? '' : String(section)),
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
  setIgnoreMouse: (v, why) => ipcRenderer.send('companion:mouse:ignore', v, why === 'pill' ? 'pill' : undefined),
  // The overlay took the mouse far from the Knot, or the Knot was dragged: for route.log.
  noteMouse: (note) => ipcRenderer.send('companion:mouse:note', note),
  // A touchscreen: where the controls are, a finger seen, a text field tapped (src/touch-pad.js).
  touchPadRects: (rects) => ipcRenderer.send('companion:touchpad:rects', rects),
  touchPadSeen: () => ipcRenderer.send('companion:touchpad:seen'),
  touchPadFocus: () => ipcRenderer.send('companion:touchpad:focus'),
  // Nothing here wants keys now: the keyboard goes back to the app.
  releaseKeys: () => ipcRenderer.send('companion:keys:release'),
  // The Knot strand: guide sessions, dismissal, consent, corner.
  guideAsk: (payload) => ipcRenderer.send('companion:guide:ask', payload),
  // The composer opened: a brain process can start before the words are in.
  guideWarm: () => ipcRenderer.send('companion:guide:warm'),
  // The Knot's own voice: one line in, samples back (Int16 PCM); stop drops the rest.
  voiceSay: (text) => ipcRenderer.invoke('companion:voice:say', String(text || '')),
  voiceStop: () => ipcRenderer.send('companion:voice:stop'),
  guideDismiss: (reason, sessionId) => ipcRenderer.send('companion:guide:dismiss', { reason: String(reason || ''), sessionId: sessionId == null ? '' : String(sessionId) }),
  guideKeep: (sessionId) => ipcRenderer.send('companion:guide:keep', { sessionId }),
  guideSkip: (sessionId) => ipcRenderer.send('companion:guide:skip', { sessionId }),
  strandArrived: (seq) => ipcRenderer.send('companion:strand:arrived', { seq: seq == null ? null : Number(seq) }),
  knotCornerSet: (corner) => ipcRenderer.invoke('companion:knot:corner:set', corner),
  // Free position, as fractions of the work area, stored per display.
  knotPosSet: (pos) => ipcRenderer.invoke('companion:knot:pos:set', { fx: Number(pos && pos.fx), fy: Number(pos && pos.fy) }),
  // Where the Knot is right now (window DIPs), so main can read the brightness behind it.
  knotAt: (pos) => ipcRenderer.send('companion:knot:at', { x: Number(pos && pos.x), y: Number(pos && pos.y) }),
  openPane: (url) => ipcRenderer.send('companion:open-pane', url),
  // A file dropped on the Knot. The sandboxed renderer cannot read File.path;
  // webUtils resolves it, and main validates the extension and size.
  filePath: (file) => (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : ''),
  fileAsk: (payload) => ipcRenderer.send('companion:file:ask', { path: String(payload && payload.path || ''), name: String(payload && payload.name || '') }),
  log: (msg) => ipcRenderer.send('companion:log', msg),
  assignmentPainted: (payload) => ipcRenderer.send('companion:assignment:painted', payload),
  assignmentBench: (payload) => ipcRenderer.invoke('companion:assignment:bench', payload),
  on: (channel, cb) => {
    const allowed = ['mouse:forced', 'capture:state', 'llm:start', 'llm:token', 'llm:done', 'llm:error', 'llm:busy', 'status', 'transcript', 'spar:state', 'cursor:probe', 'touchpad:event', 'knot:set', 'tour:start', 'daily:line', 'capture:limit', 'cursor:away',
      'assignment:takeover', 'assignment:paint', 'assignment:voice', 'guide:state', 'guide:target', 'guide:update', 'guide:retract', 'guide:bubble', 'guide:done', 'guide:hint', 'guide:say', 'guide:circle', 'guide:marks', 'guide:marks:clear', 'voice:state', 'voice:hush', 'knot:corner', 'knot:pos', 'knot:move', 'knot:size', 'knot:island', 'hands:state', 'tasks:event', 'tasks:windows', 'tour:card', 'tour:update', 'tour:end', 'knot:backdrop', 'power:state', 'ptt:state', 'settings:changed', 'capture:policy', 'focus:guard', 'play:start', 'quick:open'];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => cb(data));
  }
});
