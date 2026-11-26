'use strict';
// The Home window quick wins from the 2026-10-13 Apple-standard review
// (fixes 2, 6, 7, 8, 10, 11, 12), checked in the shipped sources.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', 'home', ...p), 'utf8');
const html = read('index.html'), css = read('home.css'), js = read('home.js'), map = read('map.js');

test('fix 2: the Map is in the rail, Fit never hides a small map, edges end at the card edge', () => {
  assert.match(html, /<button data-view="map">Map<\/button>/);
  assert.match(map, /if\(\(state\.map\.graph\?\.nodes\|\|\[\]\)\.length<SMALL_MAP\)return true;/);
  assert.match(map, /function edgePoint\(from,to\)/);
  assert.doesNotMatch(map, /start\.x\+72/);
  assert.doesNotMatch(html, /map-caption/);
});

test('fix 6: one type scale, nothing below 11 px', () => {
  const sizes = [...css.matchAll(/font(?:-size)?:\s*([0-9]+)px/g)].map(m => Number(m[1]));
  assert.ok(sizes.length > 10);
  assert.ok(sizes.every(n => n >= 11), 'smallest is ' + Math.min(...sizes));
  assert.deepEqual([...new Set(sizes)].sort((a, b) => a - b), [11, 12, 13, 15, 20, 26]);
});

test('fix 7: success fades as a toast, errors stay on the row, the line clears on a page change', () => {
  assert.match(html, /<p id="toast" role="status" aria-live="polite" hidden><\/p>/);
  assert.match(js, /toastTimer = setTimeout\(\(\) => \{ t\.hidden = true; \}, 3000\)/);
  assert.match(js, /function rowError\(el, text\)/);
  assert.match(js, /clearNotice\(\); toast\(''\);/);
});

test('fix 8: the 80 px box is only the retention days; feed titles take the row', () => {
  assert.doesNotMatch(css, /\.field input\{width:80px\}/);
  assert.match(css, /#retention-days\{width:80px\}/);
  assert.match(html, /<label class="field wide">Feed titles<input id="focus-feeds"/);
});

test('fix 10: switch captions are one line, the rest behind More', () => {
  for (const id of ['focus-guard', 'hands', 'hide-from-capture']) {
    const at = html.indexOf('id="' + id + '"');
    const caption = html.slice(at, html.indexOf('</label>', at)).replace(/<[^>]+>/g, ' ');
    const words = caption.split(/\s+/).filter(Boolean).length;
    assert.ok(words <= 25, id + ' caption has ' + words + ' words');
    assert.match(html.slice(at, at + 1600), /<details class="more"><summary>More<\/summary>/, id);
  }
});

test('fixes 11 and 12: titles name the place; no eyebrows or numbers on things that are not a sequence', () => {
  assert.match(js, /const titles = \{ start: 'Dashboard', mynus: 'My Nūs', map: 'Map', saved: 'Saved', folders: 'Folders', settings: 'Settings', feedback: 'Feedback' \};/);
  assert.doesNotMatch(html, /class="eyebrow"/);
  assert.doesNotMatch(html, /<nav[\s\S]*?<span>0\d<\/span>[\s\S]*?<\/nav>/);
  assert.doesNotMatch(html, /\d\d \/ [A-Z]/);
  // Numbers stay only where order is real: the tour's cards, on the overlay. The dashboard has none.
  const steps = [...html.matchAll(/class="step-no"/g)].length;
  assert.equal(steps, 0);
  assert.equal(html.slice(html.indexOf('id="view-settings"')).includes('step-no'), false);
});
