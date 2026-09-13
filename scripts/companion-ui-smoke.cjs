// Isolated renderer fixture. No production preload, account, microphone or model.
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'nus-renderer-smoke-')));
const out = process.argv[2];
const errors = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1280, height: 900, show: false, webPreferences: { preload: path.join(__dirname, 'companion-fixture-preload.cjs'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true } });
  win.webContents.on('console-message', (event, level, message) => { if (level >= 3 || event.level === 'error') errors.push(message || event.message); });
  win.webContents.on('render-process-gone', () => errors.push('renderer-gone'));
  await win.loadFile(path.join(__dirname, '../companion/renderer/index.html'));
  await new Promise((r) => setTimeout(r, 500));
  const result = await win.webContents.executeJavaScript(`(async () => {
    const knot = document.querySelector('#orb'); knot.click();
    const ask = document.querySelector('#quick-ask'); const opened = !ask.classList.contains('hidden');
    knot.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    const repeatedClickPreserved = !ask.classList.contains('hidden');
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#202b43'; ctx.fillRect(0, 0, 300, 80); ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText('Example Settings button', 15, 45);
    const selected = { id: 'fixture-selection', createdAt: Date.now(), name: 'Settings', type: 'Button', source: 'accessibility', bbox: { x: 100, y: 100, w: 300, h: 80 }, imageDataUrl: canvas.toDataURL(), canReselect: true };
    window.__fixture.emit('inspect:ready', selected); await new Promise(r => setTimeout(r, 70));
    const selectedPreview = !document.querySelector('#inspect-preview').classList.contains('hidden') && document.querySelector('#inspect-context').textContent.includes('Claude');
    const modes = [];
    for (const intent of ['ask', 'explain', 'fix', 'guide']) {
      const button = document.querySelector('#quick-modes [data-intent="' + intent + '"]'); button.click();
      modes.push(button.getAttribute('aria-pressed') === 'true' && document.querySelector('#quick-intent').value === intent && document.querySelectorAll('#quick-modes [aria-pressed="true"]').length === 1);
    }
    document.querySelector('#quick-modes [data-intent="explain"]').click();
    window.__fixture.emit('guide:target', { bbox: selected.bbox, task: 'ask', generation: 1, kicker: 'Selected · Settings', hint: 'Enter explains it.', actions: [] });
    await new Promise(r => setTimeout(r, 850));
    const strandPixels = document.querySelector('#strand-layer').getContext('2d').getImageData(0, 0, 1280, 900).data;
    const pointingBeforeAnswer = strandPixels.some((value, index) => index % 4 === 3 && value > 0) && !document.querySelector('#guide-bubble').classList.contains('hidden');
    const corners = [];
    for (const corner of ['tl', 'tr', 'bl', 'br']) {
      document.querySelector('#corner-pick [data-corner="' + corner + '"]').click();
      await new Promise(r => setTimeout(r, 50));
      const rect = ask.getBoundingClientRect();
      corners.push(rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight);
    }
    document.querySelector('#quick-send').click();
    const optionalTyping = window.__fixture.calls().at(-1)?.kind === 'inspect' && window.__fixture.calls().at(-1)?.payload.id === selected.id;
    const beforeNearby = window.__fixture.calls().filter(c => c.kind === 'inspect').length;
    window.__fixture.emit('inspect:ready', { ...selected, id: 'fixture-nearby', source: 'point-context', type: 'area', name: 'Area around your pointer', point: { x: 220, y: 140 } });
    const nearbyPrompt = document.querySelector('#inspect-context').textContent.includes('not a detected control') && document.querySelector('#quick-input').placeholder.includes('What’s happening here?') && document.querySelector('#quick-mode-hint').textContent.includes('ask what you need');
    const nearbyNoAutoSend = window.__fixture.calls().filter(c => c.kind === 'inspect').length === beforeNearby;
    document.querySelector('#quick-send').click();
    const nearbySend = window.__fixture.calls().at(-1);
    const nearbyClarification = nearbySend?.kind === 'inspect' && nearbySend.payload.id === 'fixture-nearby' && nearbySend.payload.text.includes('ask what issue I need help with');
    window.__fixture.emit('inspect:ready', selected);
    window.__fixture.emit('guide:state', { state: 'paused' });
    document.querySelector('#quick-intent').value = 'ask'; document.querySelector('#quick-input').value = 'A general question'; document.querySelector('#quick-send').click();
    const noScreenAsk = window.__fixture.calls().at(-1)?.kind === 'ask' && document.querySelector('#inspect-preview').classList.contains('hidden');
    window.__fixture.emit('inspect:failed', { message: 'Windows took too long.' });
    const recoverableSelectionFailure = !ask.classList.contains('hidden') && document.querySelector('#inspect-context').textContent.includes('Ctrl+Shift+T to retry');
    window.__fixture.emit('conversation:restore', { turns: [{ role: 'user', text: 'short', voiceSessionId: 'voice-fixture' }, { role: 'assistant', text: 'An answer' }] });
    window.__fixture.emit('voice:transcript', { sessionId: 'voice-fixture', revision: 1, final: true, text: 'The full recovered voice transcript' });
    const transcriptRecovery = document.querySelectorAll('#messages .user-bubble').length === 1 && document.querySelector('#messages .user-bubble').textContent === 'The full recovered voice transcript';
    knot.click();
    document.querySelector('#quick-settings').click(); await new Promise(r => setTimeout(r, 50));
    const motion = document.querySelector('#reduce-motion');
    motion.checked = true; motion.dispatchEvent(new Event('change')); await new Promise(r => setTimeout(r, 50));
    return { opened, repeatedClickPreserved, selectedPreview, modeButtons: modes.every(Boolean), pointingBeforeAnswer, recoverableSelectionFailure, optionalTyping, nearbyPrompt, nearbyNoAutoSend, nearbyClarification, noScreenAsk, transcriptRecovery, cornersFit: corners.every(Boolean), settingsOpened: !document.querySelector('#settings-scrim').classList.contains('hidden'), reducedMotion: document.documentElement.classList.contains('reduced-motion'), recordingControls: !!document.querySelector('#quiet-voice-wave'), contextControl: !!document.querySelector('#quick-intent') };
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  if (out) { fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'companion-settings-fixture.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG()); }
  await win.webContents.executeJavaScript(`(() => {
    document.querySelector('#s-close').click();
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 80;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#202b43'; ctx.fillRect(0, 0, 300, 80); ctx.fillStyle = '#fff'; ctx.font = '20px sans-serif'; ctx.fillText('Example Settings button', 15, 45);
    window.__fixture.emit('inspect:ready', { id: 'fixture-preview', createdAt: Date.now(), name: 'Settings', type: 'Button', source: 'accessibility', bbox: { x: 100, y: 100, w: 300, h: 80 }, imageDataUrl: canvas.toDataURL(), canReselect: true });
  })()`);
  await new Promise(r => setTimeout(r, 100));
  if (out) fs.writeFileSync(path.join(out, 'companion-selection-fixture.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  await win.webContents.executeJavaScript(`(() => {
    const canvas = document.createElement('canvas'); canvas.width = 480; canvas.height = 200;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#f7f5ef'; ctx.fillRect(0, 0, 480, 200); ctx.fillStyle = '#222'; ctx.font = '18px sans-serif'; ctx.fillText('A paragraph, image, chart, or blank area', 16, 70); ctx.fillText('can be the starting point for help.', 16, 102);
    window.__fixture.emit('inspect:ready', { id: 'fixture-nearby-preview', createdAt: Date.now(), name: 'Area around your pointer', type: 'area', source: 'point-context', bbox: { x: 100, y: 100, w: 480, h: 320 }, point: { x: 340, y: 260 }, imageDataUrl: canvas.toDataURL(), canReselect: true });
    window.__fixture.emit('guide:target', { bbox: { x: 336, y: 256, w: 8, h: 8 }, task: 'ask', generation: 2, kicker: 'Your spot · not a detected control', instruction: 'What’s happening here? What would you like help with?', hint: 'Type the issue, or press Enter to let Claude describe this preview and ask a question. Nothing is shared until Send.', actions: [] });
  })()`);
  await new Promise(r => setTimeout(r, 850));
  if (out) fs.writeFileSync(path.join(out, 'companion-nearby-fixture.png'), (await win.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
  const ok = Object.values(result).every(Boolean) && errors.length === 0;
  if (out) fs.writeFileSync(path.join(out, 'renderer-smoke.json'), JSON.stringify({ fixtureOnly: true, ok, result, errors }, null, 2));
  console.log(JSON.stringify({ fixtureOnly: true, ok, result, errors })); win.destroy(); app.exit(ok ? 0 : 1);
}).catch((e) => { console.error(e); app.exit(1); });
