// Renders the four neutral test pages to PNG, off screen (no window is shown).
//   node_modules/.bin/electron companion/test/ask-routing/shots/render.js
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const w = new BrowserWindow({ show: false, width: 1280, height: 720, webPreferences: { offscreen: true } });
  for (const name of ['article', 'dialog', 'settings', 'sheet']) {
    const html = fs.readFileSync(path.join(__dirname, name + '.html'), 'utf8');
    for (let tries = 0; tries < 3; tries++) {
      try { await w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); break; } catch (e) { console.log(name + ': ' + e.message); await new Promise((r) => setTimeout(r, 300)); }
    }
    await new Promise((r) => setTimeout(r, 500));
    const img = await w.webContents.capturePage();
    fs.writeFileSync(path.join(__dirname, name + '.png'), img.toPNG());
    console.log('wrote ' + name + '.png');
  }
  app.quit();
});
