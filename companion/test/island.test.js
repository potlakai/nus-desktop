const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

test('island mode is a setting, off by default, switched from the tray and Home', () => {
  assert.match(read('companion/src/store.js'), /knotIsland: false/, 'the free Knot stays the default');
  const main = read('companion/index.js');
  assert.match(main, /function islandOn\(\) \{ return store\.getSettings\(\)\.knotIsland === true/);
  assert.match(main, /label: 'Island mode \(top bar\)', type: 'checkbox', checked: islandOn\(\)/, 'the tray has the switch');
  assert.match(main, /hasOwnProperty\.call\(patch, 'knotIsland'\)\) \{ send\('knot:island', \{ on: islandOn\(\) \}\)/, 'a patch tells the Knot at once');
  assert.match(main, /if \(!islandOn\(\)\) send\('knot:pos', knotPosPayload\(\)\)/, 'turning it off sends the Knot back to its saved spot');
  assert.match(main, /send\('knot:island', \{ on: islandOn\(\) \}\);\s*send\('capture:policy'/, 'a fresh page starts in the right mode');
  assert.match(main, /'knotHidden', 'knotIsland', 'hands'\]/, 'the overlay may set it');
  assert.match(read('src/main-companion.js'), /'hands', 'knotIsland'\]\) if \(typeof patch\[key\] === 'boolean'\)/, 'Home may set it');
  assert.match(read('companion/preload.js'), /'knot:island'/, 'the renderer may hear it');
  assert.match(read('companion/home/index.html'), /<input id="knot-island" type="checkbox">Island mode/, 'Home shows the switch');
  const home = read('companion/home/home.js');
  assert.match(home, /\$\('#knot-island'\)\.checked=s\.knotIsland===true;/, 'Home paints it from the setting');
  assert.match(home, /'knot-island':\['knotIsland',e=>e\.checked\]/, 'Home sets it');
});

test('docked, the Knot rides the right end of a pill at the top centre and never wanders', () => {
  const r = read('companion/renderer/renderer.js');
  assert.match(r, /const ISLAND = KSPEC\.character\.island;/, 'the pill takes its numbers from the spec');
  assert.match(read('companion/renderer/knot-spec.js'), /island: \{\s*top: 8, h: 40, pad: 4, idle: 48, scale: \.41, drop: 10,/, '8 px below the top edge, 40 px tall, 48 wide idle');
  assert.match(r, /function islandKnotX\(width\) \{ return Math\.round\(window\.innerWidth \/ 2 \+ width \/ 2\) - ISLAND\.pad - ISLAND\.h \/ 2; \}/, 'the Knot sits inside the right end');
  assert.match(r, /if \(islandOn && !opts\.dock\) \{ dockKnot\(opts\); return; \}/, 'every placement docks while it is on');
  assert.match(r, /if \(islandOn\) \{ dockKnot\(\); done\(\); return false; \}/, 'no skating while docked');
  assert.match(r, /if \(!knotPos \|\| islandOn\) return null;/, 'no stepping aside while docked');
  assert.match(r, /opts\.persist && !opts\.dock && nus\.knotPosSet/, 'the dock never overwrites the saved free spot');
  assert.match(r, /const scale = islandOn \? ISLAND\.scale : \(KNOT_SCALES\[size\] \|\| 1\);/, 'drawn small in the pill');
  const css = read('companion/renderer/styles.css');
  assert.match(css, /#island \{\s*position: fixed; top: 8px;/);
  assert.match(css, /background: #000;[^}]*border-radius: 20px;/, 'black and fully rounded');
  assert.match(css, /pointer-events: none;\s*transition: box-shadow/, 'the pill never takes the mouse');
  assert.match(css, /body\.island #knot-bloom \{ display: none !important; \}/);
});

test('words go into the pill, cards drop below it, and the pill is masked out of screenshots', () => {
  const r = read('companion/renderer/renderer.js');
  assert.match(r, /if \(islandOn\) \{ islandLine\(p\.text, Number\(p\.ms\) \|\| 7000\);/, 'the live You: line and the first sentence land in the pill');
  assert.match(r, /else if \(handsState\.active\) \{ word = handsState\.waiting \? 'Hands is waiting for you' : 'Hands is working'; tone = 'hands'; \}/, 'Hands at work reads Hands is working, or waiting for you on a card');
  assert.match(r, /function placeSlot\(el\) \{\s*if \(islandOn\) \{/, 'cards by the Knot drop below the pill');
  assert.match(r, /el\.style\.top = \(b\.bottom \+ ISLAND\.drop\) \+ 'px';/);
  assert.match(r, /el\.style\.left = Math\.max\(8, Math\.round\(\(W - bw\) \/ 2\)\) \+ 'px';/, 'the card sits on the screen\'s centre line, under the pill');
  assert.match(r, /function reportHintRect\(\) \{\s*if \(islandOn\) \{ reportIslandRect\(\); return; \}/, 'the pill reports through the hint mask slot');
  assert.match(r, /nus\.assignmentPainted\(\{ hint: rect \}\)/);
  assert.doesNotMatch(r, /island[^\n]*eye/i, 'no eyes on the Knot, ever');
});

test('the thread leaves from the seam at any drawn size', () => {
  const e = read('companion/renderer/knot-engine.js');
  assert.match(e, /posScale = r\.width > 0 \? r\.width \/ G\.size : 1;/);
  assert.match(e, /return vec\(pos\.x \+ \(a\.x - C\) \* posScale, pos\.y \+ \(a\.y - C\) \* posScale\);/);
});

test('Hands just does it: no card naming what it touches, no thread to a whole window', () => {
  const r = read('companion/renderer/renderer.js');
  assert.match(r, /const silent = task === 'hands' \|\| !!p\.quiet;/);
  assert.match(r, /if \(silent && rectNow\.w >= window\.innerWidth \* 0\.5 && rectNow\.h >= window\.innerHeight \* 0\.5\) \{ pendingBubble = null; return; \}/);
  assert.match(r, /pendingBubble = silent \? null : \{/);
});

test('the state word sits at the left with one accent, the Knot at the right, on Clicky\'s timing (renders-0115, O2 B fast)', () => {
  const r = read('companion/renderer/renderer.js'), css = read('companion/renderer/styles.css'), spec = read('companion/renderer/knot-spec.js');
  const html = r.match(/islandEl\.innerHTML = '([^']+)'/)[1];
  assert.ok(html.indexOf('isl-text') < html.indexOf('isl-slot'), 'words first, the Knot slot last');
  assert.ok(html.indexOf('isl-dot') < html.indexOf('isl-word'), 'the accent dot sits before the word');
  assert.match(html, /isl-esc[^<]*<kbd>Esc<\/kbd>to stop/, 'Esc to stop lives in the pill');
  assert.match(css, /#island\.hands-live \.isl-esc \{ display: flex; \}/, 'shown only while Hands has the mouse');
  assert.match(r, /listening: 'Listening, release to send', transcribing: 'Thinking'/, 'the four words from the picks');
  assert.match(r, /else if \(speakingNow\) \{ word = 'Speaking'; tone = 'speaking'; \}/);
  assert.match(r, /if \(pttHeld \|\| guideState === 'listening' \|\| state === 'listening'\) \{ word = ISLAND_WORDS\.listening; tone = 'listening'; \}/, 'the held key outranks everything');
  assert.match(spec, /open: \{ over: 1\.07, snap: \.017, settle: \.07 \}/, '70 ms open with one frame past the target');
  assert.match(spec, /close: \{ low: \.77, high: 1\.4, at: \[\.15, \.25, \.48\] \}/, '150 ms close, a bounce at 250, settled by 480');
  assert.match(r, /kind: to <= ISLAND\.idle && from > ISLAND\.idle \? 'close' : 'move'/, 'only the return to idle bounces');
  assert.match(r, /orbEl\.style\.transform = 'translate\(' \+ \(islandKnotX\(w\) - base\)\.toFixed\(2\) \+ 'px,0\)';/, 'the orb rides a transform while the pill moves');
  for (const tone of ['listening', 'thinking', 'speaking', 'reading', 'hands']) assert.match(css, new RegExp("#island\\[data-state='" + tone + "'\\] \\{ --isl-acc: "), tone + ' has an accent');
  assert.match(css, /#island\[data-state='speaking'\] \{ --isl-acc: 89,185,255;/, 'speaking is the Knot\'s blue');
  assert.match(css, /#island\[data-state='hands'\] \{ --isl-acc: 255,199,106;/, 'Hands is work, so it wears thinking\'s amber, not the render\'s teal');
  assert.doesNotMatch(css.slice(css.indexOf('Island mode')), /teal|#69E2CF/i, 'no fourth colour in the pill');
  assert.match(css, /#island\[data-state\]:not\(\[data-state='idle'\]\) \.isl-dot \{ display: block; \}/);
  assert.match(css, /#island \{\s*position: fixed; top: 8px; left: 50%; translate: -50% 0;/, 'centred, growing both ways');
  const main = read('companion/index.js');
  assert.match(main, /onActive: \(on\) => \{ send\('hands:state', \{ active: !!on, waiting: false \}\);/, 'main says when Hands has the mouse');
  assert.match(main, /pending\.ask = \(card, action, ctx\) => \{ send\('hands:state', \{ active: true, waiting: true \}\);/, 'and when it waits on a card');
  assert.match(read('companion/preload.js'), /'hands:state'/, 'the renderer may hear it');
  assert.match(r, /nus\.on\('hands:state'/);
});
