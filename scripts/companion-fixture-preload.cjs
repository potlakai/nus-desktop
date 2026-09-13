// Used only by companion-ui-smoke.cjs. No production IPC or external services.
const { contextBridge } = require('electron');
const listeners = new Map();
const calls = [];
const settings = { provider: 'gemini', apiKeys: {}, models: { gemini: {} }, shortcuts: { assist: 'CommandOrControl+Return' }, smart: false, onboarded: true, speakReplies: false, shareNusContextWithProvider: false, _founderTools: false };
const emit = (channel, payload) => listeners.get(channel)?.(payload);
contextBridge.exposeInMainWorld('nus', {
  platform: 'win32', settingsGet: async () => settings, settingsSet: async patch => Object.assign(settings, patch),
  shortcutAssistSet: async accelerator => ({ ok: true, accelerator }), captureState: async () => ({ active: false }),
  captureToggle: async () => ({ active: false }), packStatus: async () => ({ live: { ok: false, path: '' }, spar: { ok: false, path: '' } }),
  nusContextStatus: async () => ({ ok: true, updatedAt: new Date().toISOString() }), sparReset: async () => true,
  deepQuery: async () => '', ask: payload => calls.push({ kind: 'ask', payload }),
  inspectSubmit: payload => calls.push({ kind: 'inspect', payload }), inspectCancel: () => emit('inspect:cleared', {}),
  inspectRegion: () => {}, micPcm: () => {}, systemPcm: () => {}, setIgnoreMouse: () => {}, openPane: () => {}, log: () => {},
  guideAsk: payload => calls.push({ kind: 'guide', payload }), guideDismiss: () => {}, guideKeep: () => {}, guideSkip: () => {}, strandArrived: () => {},
  knotCornerSet: async () => true, getZoomLevel: () => 0, on: (channel, callback) => { listeners.set(channel, callback); },
});
contextBridge.exposeInMainWorld('__fixture', { emit, calls: () => calls.slice() });
