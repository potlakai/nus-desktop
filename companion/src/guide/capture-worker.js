'use strict';
// A windowless Electron process keeps Windows desktop enumeration off the UI thread.
const { app } = require('electron');
const path = require('path');
app.setPath('userData', path.join(app.getPath('temp'), 'nus-assignment-capture-' + process.pid));
const { captureDisplay } = require('../screen');
const { captureForModel } = require('./capture-model');
let queue = Promise.resolve();
process.on('disconnect', () => app.quit());
process.on('message', message => {
  if (!message || (message.type !== 'capture' && message.type !== 'model')) return;
  queue = queue.then(async () => {
    await app.whenReady();
    try {
      if (message.type === 'model') {
        // The guide's screenshot: grab, mask, shrink and JPEG-encode here, so
        // the UI thread only ever sees a few hundred KB.
        const { screen, nativeImage } = require('electron');
        const r = await captureForModel({ displayId: message.displayId, ...message.opts, captureDisplay, electron: { screen, nativeImage } });
        process.send?.({ id: message.id, model: r || null });
        return;
      }
      const cap = await captureDisplay(message.displayId, { ...message.opts, dataUrl: false });
      if (!cap) { process.send?.({ id: message.id, cap: null }); return; }
      const imageSize = cap.image.getSize();
      process.send?.({ id: message.id, cap: { ...cap, bitmap: cap.image.toBitmap(), imageSize } });
    } catch (e) { process.send?.({ id: message.id, error: e.message }); }
  });
});
app.whenReady().then(() => process.send?.({ type: 'ready' }));
