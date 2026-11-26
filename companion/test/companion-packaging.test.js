// Every file under src/ that the Companion requires must be in the Companion
// build's files list, or the installed app dies at start with "Cannot find
// module" (0.1.7-dogfood.2, 2026-10-19: src/whisper-server.js was left out and
// the smoke boot crashed). Tests run from the source tree, so only this catches it.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const config = require(path.join(root, 'electron-builder.companion.config.js'));
const packedSrc = new Set(config.files.filter((f) => /^src\/[^*!]+\.js$/.test(f)));

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!['test', 'node_modules'].includes(e.name)) walk(full, out); }
    else if (/\.js$/.test(e.name) && !/\.test\.js$/.test(e.name) && !/\.bak-/.test(e.name)) out.push(full);
  }
  return out;
}

test('every src/ file the packaged Companion requires is in its build files list', () => {
  const queue = walk(path.join(root, 'companion')).concat([...packedSrc].map((f) => path.join(root, f)));
  const seen = new Set();
  const missing = [];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/require\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g)) {
      let target = path.resolve(path.dirname(file), m[1]);
      if (!/\.(js|json|cjs)$/.test(target)) target += fs.existsSync(target + '.js') ? '.js' : '';
      const rel = path.relative(root, target).split(path.sep).join('/');
      if (!rel.startsWith('src/') || !rel.endsWith('.js')) continue;
      if (rel === 'src/config.js') continue;   // optional at run time, never packed
      if (!packedSrc.has(rel)) missing.push(rel + ' (required by ' + path.relative(root, file).split(path.sep).join('/') + ')');
      queue.push(target);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
