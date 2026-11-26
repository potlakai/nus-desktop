'use strict';
// Watches Downloads (and one folder the person chooses) for export archives
// and imports them by itself: a ChatGPT or Claude export, a Google Takeout
// with Gemini or Keep, an Apple data copy with iCloud Notes (ingest.js has the
// shapes). The person downloads the export as they normally would; Nūs notices
// it, reads it, and says "Imported 12 conversations from ChatGPT".
//
// - Only .zip files directly in the watched folders; nothing is extracted,
//   moved or deleted. A ZIP that is not an export is looked at once (its
//   directory only) and remembered, never opened again.
// - A file still being written (size or time changed since the last look, or
//   touched in the last few seconds) waits for the next look.
// - What was seen is remembered by path, size and time (seenFile), so a
//   restart does not import the same archive twice; the store dedupes by
//   conversation id anyway.
// - Off with the watchImports setting (Home), and never in a smoke run.
const fs = require('fs');
const path = require('path');

const SETTLE_MS = 4000;

function createImportWatcher({ folders = () => [], enabled = () => true, importZip, seenFile, onImported = () => {}, log = () => {}, now = () => Date.now(), intervalMs = 15000 } = {}) {
  let seen = {};
  let timer = null, running = false, watchers = [];
  const pending = new Map();   // path -> "size|mtime" at the last look
  try { seen = JSON.parse(fs.readFileSync(seenFile, 'utf8')).seen || {}; } catch (_) { seen = {}; }
  function save() {
    if (!seenFile) return;
    try {
      const keys = Object.keys(seen);
      if (keys.length > 2000) for (const k of keys.slice(0, keys.length - 2000)) delete seen[k];
      fs.mkdirSync(path.dirname(seenFile), { recursive: true });
      fs.writeFileSync(seenFile, JSON.stringify({ seen }), { mode: 0o600 });
    } catch (e) { log('watch state save failed: ' + e.message); }
  }

  // One look at every watched folder. -> [{ file, result }] for what was imported.
  async function scan() {
    if (running || !enabled()) return [];
    running = true;
    const done = [];
    try {
      for (const dir of Array.from(new Set(folders().filter(Boolean).map((d) => path.resolve(d))))) {
        let names = [];
        try { names = fs.readdirSync(dir); } catch (_) { continue; }
        for (const name of names) {
          if (!/\.zip$/i.test(name)) continue;
          const file = path.join(dir, name);
          let st;
          try { st = fs.statSync(file); } catch (_) { continue; }
          if (!st.isFile()) continue;
          const sig = st.size + '|' + Math.round(st.mtimeMs);
          if (seen[file] && seen[file].sig === sig) continue;
          if (now() - st.mtimeMs < SETTLE_MS || pending.get(file) !== sig) { pending.set(file, sig); continue; }
          pending.delete(file);
          let result;
          try { result = await importZip(file); } catch (e) { result = { error: e.message }; }
          seen[file] = { sig, at: new Date(now()).toISOString(), kinds: result && result.kinds, conversations: result && result.conversations || 0, error: result && result.error || undefined };
          save();
          if (result && result.error) log('skipped ' + name + ': ' + result.error);
          else if (result && result.conversations) { log('imported ' + name + ': ' + result.line); done.push({ file, result }); onImported(result, file); }
          await new Promise((r) => setImmediate(r));
        }
      }
    } finally { running = false; }
    return done;
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => { scan().catch((e) => log('scan failed: ' + e.message)); }, intervalMs);
    // A download landing triggers a look sooner than the next tick.
    for (const dir of folders().filter(Boolean)) {
      try { const w = fs.watch(dir, { persistent: false }, (_e, name) => { if (name && /\.zip$/i.test(String(name))) setTimeout(() => scan().catch(() => {}), SETTLE_MS + 500); }); w.on('error', () => {}); watchers.push(w); } catch (_) { /* polling covers it */ }
    }
    setTimeout(() => scan().catch(() => {}), 3000);
  }
  function stop() { clearInterval(timer); timer = null; for (const w of watchers) { try { w.close(); } catch (_) { /* closed */ } } watchers = []; }
  function restart() { stop(); start(); }
  function status() { return { on: Boolean(timer), folders: folders().filter(Boolean), seen: Object.keys(seen).length, imported: Object.values(seen).filter((s) => s.conversations).length }; }

  return { scan, start, stop, restart, status };
}

module.exports = { createImportWatcher, SETTLE_MS };
