// The region mark (renders-0115-2026-11-02, O4 option 2, drawn as option C):
// only when the sentence names an area and the read has a container that
// frames the control; the smallest such; never the window, never the control.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { regionFor, namesArea } = require('../src/guide/region');
const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

const win = { x: 0, y: 0, w: 1600, h: 1000 };
const control = { x: 900, y: 120, w: 40, h: 28 };
const containers = [
  { type: 'Pane', name: '', rect: { x: 0, y: 0, w: 1600, h: 1000 } },          // the window itself
  { type: 'Pane', name: 'Compose', rect: { x: 800, y: 100, w: 760, h: 820 } },  // the compose area
  { type: 'ToolBar', name: '', rect: { x: 800, y: 100, w: 760, h: 60 } },       // its toolbar, smaller still
  { type: 'Pane', name: 'Sidebar', rect: { x: 0, y: 60, w: 240, h: 900 } },     // does not frame the control
  { type: 'Button', name: 'Send', rect: { x: 820, y: 110, w: 80, h: 36 } },     // not a container type
];

test('a sentence that names an area gets the smallest container round the control', () => {
  assert.deepEqual(regionFor('Click the paperclip in the compose area.', control, containers, win), { x: 800, y: 100, w: 760, h: 60 });
  assert.deepEqual(regionFor('Use the toolbar at the top of the editor.', control, containers, win), { x: 800, y: 100, w: 760, h: 60 });
  const noToolbar = containers.filter(c => c.type !== 'ToolBar');
  assert.deepEqual(regionFor('Look in the compose panel.', control, noToolbar, win), { x: 800, y: 100, w: 760, h: 820 });
});

test('no area in the sentence, no region; the lasso alone stays the default', () => {
  assert.equal(regionFor('Click the paperclip.', control, containers, win), null);
  assert.equal(regionFor('Press Send when the draft looks right.', control, containers, win), null);
  assert.equal(namesArea('Then close this window.'), false);
  assert.equal(namesArea('In the sidebar, choose Drafts.'), true);
});

test('never the window, never something the size of the control, never a frame that misses it', () => {
  const onlyWindow = [containers[0]];
  assert.equal(regionFor('In this area.', control, onlyWindow, win), null, 'the window is not a region');
  const tight = [{ type: 'Group', rect: { x: 898, y: 118, w: 44, h: 32 } }];
  assert.equal(regionFor('In this area.', control, tight, win), null, 'a frame the size of the control is the control');
  assert.equal(regionFor('In the sidebar.', control, [containers[3]], win), null, 'a container elsewhere does not count');
  assert.equal(regionFor('In this area.', control, [{ type: 'Pane', rect: { x: 0, y: 0, w: 1200, h: 1000 } }], win), null, 'over 70 percent of the window is the window');
  assert.equal(regionFor('In this area.', control, [], win), null);
  assert.equal(regionFor('In this area.', null, containers, win), null);
});

test('the guide step carries the region, and the probe lists containers for it', () => {
  const session = read('companion/src/guide/session.js');
  assert.match(session, /require\('\.\/region'\)/);
  assert.match(session, /s\.containers = \(\(listRes && listRes\.containers\) \|\| \[\]\)\.filter\(\(e\) => e && e\.rect\);/, 'the read\'s containers are kept with the session');
  assert.match(session, /const region = regionFor\(target\.instruction, target\.rect, s\.containers \|\| \[\], s\.frame\);/);
  assert.match(session, /region: region \? physRectToWindow\(region, this\.d\.winBounds\(\), this\.d\.screenToDip\) : undefined,/, 'in window coordinates like the bbox');
  const probe = read('companion/src/win/probe.ps1');
  assert.match(probe, /\$Containers = @\{/, 'the probe knows which types frame others');
  assert.match(probe, /containers=@\(\$containers\.ToArray\(\)\)/, 'and returns them beside the elements');
  const r = read('companion/renderer/renderer.js');
  assert.match(r, /const region = p\.region && Number\.isFinite\(p\.region\.w\) && p\.region\.w > 0 \? dipRectToCss\(p\.region\) : null;/);
  assert.match(r, /moveKnotTo\(spotBeside\(rect\), \{ persist: false, keepGuide: true, lasso: rect, region \}\);/, 'the walkthrough flight carries it');
});
