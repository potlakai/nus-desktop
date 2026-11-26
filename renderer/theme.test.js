'use strict';
// The theme switch: which theme wins, that it lands before the first paint, and
// that both themes define the same properties (a theme missing one is a window
// that half-changes colour).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const theme = require('../renderer/themes.js');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// The smallest document the module needs.
function fakeDoc() {
  const attrs = {};
  return {
    documentElement: {
      setAttribute: (k, v) => { attrs[k] = String(v); },
      removeAttribute: (k) => { delete attrs[k]; },
      getAttribute: (k) => (k in attrs ? attrs[k] : null),
    },
    attrs,
  };
}
function fakeStorage(initial) {
  const m = new Map(Object.entries(initial || {}));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test('there are two themes, and the butler is the default', () => {
  assert.deepEqual(theme.THEMES, ['jarvis', 'nus']);
  assert.equal(theme.DEFAULT, 'jarvis');
  assert.equal(theme.normalise('nonsense'), 'jarvis');
  assert.equal(theme.normalise('NuS'), 'nus');
  assert.equal(theme.normalise(undefined), 'jarvis');
});

test('the saved setting wins, then what this window showed last, then the default', () => {
  const storage = fakeStorage({ [theme.KEY]: 'nus' });
  assert.equal(theme.choose({ theme: 'jarvis' }, storage), 'jarvis', 'the setting beats the memory');
  assert.equal(theme.choose({}, storage), 'nus', 'no setting: what was last used');
  assert.equal(theme.choose({ theme: 'bogus' }, storage), 'nus', 'a bad setting falls through, not to garbage');
  assert.equal(theme.choose({}, fakeStorage()), 'jarvis', 'nothing known: the butler');
  assert.equal(theme.choose(null, null), 'jarvis', 'no storage at all still answers');
});

test('applying sets the attribute, clears the pre-paint flag and is remembered', () => {
  const doc = fakeDoc();
  const storage = fakeStorage();
  doc.documentElement.setAttribute('data-theme-pending', '1');
  const t = theme.apply('nus', { doc, storage });
  assert.equal(t, 'nus');
  assert.equal(doc.attrs['data-theme'], 'nus');
  assert.equal(doc.attrs['data-theme-pending'], undefined, 'the flag that hid the body is gone');
  assert.equal(storage.map.get(theme.KEY), 'nus', 'so the next paint starts on the right one');
});

test('a browser that refuses storage still gets a theme', () => {
  const doc = fakeDoc();
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(theme.remembered(storage), null);
  assert.equal(theme.apply('jarvis', { doc, storage }), 'jarvis');
  assert.equal(doc.attrs['data-theme'], 'jarvis');
});

test('invalid input cannot put a stranger value on the attribute', () => {
  const doc = fakeDoc();
  theme.apply('<script>', { doc, storage: fakeStorage() });
  assert.equal(doc.attrs['data-theme'], 'jarvis');
  for (const v of ['', 'NUS', '/**/', 'null']) {
    const d = fakeDoc();
    theme.apply(v, { doc: d, storage: fakeStorage() });
    assert.ok(['jarvis', 'nus'].includes(d.attrs['data-theme']), v);
  }
});

test('loading the file sets a theme before anything else can paint', () => {
  // The module self-starts, which is what makes the include in <head> enough.
  const src = read('renderer/themes.js');
  assert.match(src, /if \(root\.document\) \{/, 'the self-start exists');
  assert.match(src, /apply\(remembered\(\)\)/, 'and it applies the remembered theme');
});

test('all three windows include the theme before their own stylesheets', () => {
  for (const f of ['renderer/index.html', 'companion/renderer/index.html', 'companion/home/index.html']) {
    const html = read(f);
    const themeJs = html.indexOf('themes.js');
    const themeCss = html.indexOf('themes.css');
    assert.ok(themeJs > 0, f + ' loads themes.js');
    assert.ok(themeCss > 0, f + ' loads themes.css');
    // theme must come first, or the other sheets win for a frame
    const firstCss = html.indexOf('.css');
    assert.ok(themeCss <= firstCss, f + ' loads themes.css before the other sheets');
    assert.ok(themeJs < html.indexOf('<body'), f + ' loads themes.js in the head');
    assert.match(html, /data-theme-pending/, f + ' starts hidden until the theme is known');
  }
});

test('the browser copy and the main-process copy agree on every value', () => {
  // Two files, one rule. They exist separately because the renderer cannot
  // require from src and the main process cannot reach window.localStorage,
  // but a disagreement between them is a window and a setting that lie to each
  // other. This is the seam, pinned.
  const main = require('../src/theme.js');
  assert.deepEqual(theme.THEMES, main.THEMES, 'the same two themes, in the same order');
  assert.equal(theme.DEFAULT, main.DEFAULT, 'the same default');
  assert.equal(theme.KEY, 'jarvisTheme', 'the storage key is named once');
  for (const v of ['jarvis', 'nus', 'NUS', ' nus ', '', null, undefined, 'dark', 0, ['nus'], {}]) {
    assert.equal(theme.normalise(v), main.normalise(v), 'normalise(' + JSON.stringify(v) + ')');
    assert.equal(theme.isTheme(v), main.isTheme(v), 'isTheme(' + JSON.stringify(v) + ')');
  }
  for (const t of main.THEMES) assert.equal(theme.other(t), main.other(t), 'other(' + t + ')');
});

test('both themes define every property: a theme is a whole palette or it is a bug', () => {
  const css = read('renderer/themes.css');
  const block = (sel) => {
    const i = css.indexOf(sel);
    assert.ok(i > 0, sel + ' exists');
    const open = css.indexOf('{', i);
    const close = css.indexOf('}', open);
    return css.slice(open, close);
  };
  const vars = (text) => new Set([...text.matchAll(/(--[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
  const jarvis = vars(block(":root[data-theme='jarvis']"));
  const nus = vars(block(":root[data-theme='nus']"));
  const missing = [...jarvis].filter((v) => !nus.has(v));
  const extra = [...nus].filter((v) => !jarvis.has(v));
  assert.deepEqual(missing, [], 'Nūs is missing properties the butler sets');
  assert.deepEqual(extra, [], 'Nūs sets properties the butler does not');
  assert.ok(jarvis.size >= 15, 'the palette is real: ' + [...jarvis].join(', '));
});

test('the two themes are actually different, or the switch does nothing', () => {
  const css = read('renderer/themes.css');
  for (const v of ['--accent:', '--marble:', '--theme-bg:', '--paper-theme:']) {
    const hits = [...css.matchAll(new RegExp(v.replace(/[-]/g, '\\-') + '\\s*([^;]+);', 'g'))].map((m) => m[1].trim());
    assert.ok(hits.length >= 2, v + ' is defined for both themes');
    assert.notEqual(hits[0], hits[1], v + ' differs between the two themes');
  }
});
