// The Knot's thread: the overlay's one limb across the screen. Contract test
// for the pieces that must exist together for a guide session to render.
// (How it moves is tested for real in knot-engine.test.js.)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(root, ...p), 'utf8');
const html = read('renderer', 'index.html');
const css = read('renderer', 'styles.css');
const look = read('renderer', 'knot-look.css');
const js = read('renderer', 'renderer.js');
const engine = read('renderer', 'knot-engine.js');
const knot = read('renderer', 'knot3d.js');
const preload = read('preload.js');
const main = read('index.js');
const store = read('src', 'store.js');
const spec = require('../renderer/knot-spec.js');

test('the thread is the Knot continued across the screen, from one engine', () => {
  assert.match(engine, /window\.NusKnotEngine = \{ mount/);
  assert.match(engine, /const S = window\.NusKnotSpec;/, 'every number comes from the one config module');
  assert.match(engine, /function tailAnchor\(p\)/, 'the thread starts at the Knot\'s open tail');
  assert.match(engine, /p\.unravel = thread\.u/, 'the Knot opens as the thread leaves it');
  assert.match(engine, /getState\(\) \{\n\s+if \(!guideOut\(\)\) return 'idle';/, 'a surface reach is invisible to guide logic');
  assert.ok(!fs.existsSync(path.join(root, 'renderer', 'strand.js')), 'the old strand renderer is gone from the overlay');
});

test('the dashboard keeps its own Knot renderer untouched', () => {
  assert.match(knot, /curvePoint\(t, u\)/);
  assert.match(knot, /getTailAnchor\(u\)/);
  assert.match(knot, /reading: \{/);
  assert.match(knot, /window\.NusKnot3D = \{ mount, material/);
  assert.doesNotMatch(html, /knot3d\.js/, 'the overlay does not load it');
});

test('the overlay carries the thread canvas, the tip bubble, and the consent chip', () => {
  assert.match(html, /<canvas id="strand-layer"/);
  assert.match(html, /id="guide-bubble"/);
  assert.match(html, /id="keep-chip"/);
  assert.match(html, /id="keep-yes"/);
  assert.match(html, /id="keep-no"/);
  assert.doesNotMatch(html, /id="corner-pick"/, 'the corner picker is gone: the Knot is dragged');
  assert.ok(html.indexOf('knot-spec.js') < html.indexOf('knot-engine.js') && html.indexOf('knot-engine.js') < html.indexOf('surface.js') && html.indexOf('surface.js') < html.indexOf('renderer.js'), 'spec, engine, surfaces, then the renderer');
  assert.match(css, /#strand-layer \{ position: fixed;[^}]*pointer-events: none/);
  assert.match(js, /el\.closest\('[^']*#guide-bubble, #keep-chip, #quick-ask, #knot-hint[^']*'\)/, 'the bubble, chip, quick ask, and hint are clickable through the click-through window');
});

test('thread colour = task, the colour of the Knot = state, one source', () => {
  assert.match(css, /\[data-task="guide"\] \{ --thread-accent: #7890FF; \}/);
  assert.match(css, /\[data-task="nudge"\] \{ --thread-accent: #69E2CF; \}/);
  assert.match(css, /\[data-task="ask"\] \{ --thread-accent: #D6DBEA; \}/);
  assert.match(css, /\[data-task="remember"\] \{ --thread-accent: #A78BFA; \}/);
  const A = spec.character.accent;
  assert.match(css, new RegExp('#orb\\[data-state="reading"\\] \\{ --knot-accent: ' + A.palette.speaking), 'reading wears speaking\'s blue');
  for (const c of ['listening', 'thinking', 'speaking']) assert.doesNotMatch(css, new RegExp('--thread-accent: ' + A.palette[c]), 'a state colour never rides the thread');
  assert.match(css, new RegExp('#orb\\[data-state="listening"\\] \\{ --knot-accent: ' + A.palette.listening), 'listening is orchid');
  assert.match(look, new RegExp("data-knot-state='listening'\\] #orb \\{ --knot-accent: " + A.palette.listening + '; \\}'));
  // The CSS accents and the engine's table never drift apart.
  for (const s of ['thinking', 'reading', 'working']) {
    assert.match(look, new RegExp("data-knot-state='" + s + "'\\] #orb \\{ --knot-accent: " + A.palette[A.states[s]] + "; \\}", 'i'), s + ' accent matches the spec');
  }
  assert.doesNotMatch(css + look, /--knot-accent: #D6DBEA[^}]*\}\s*\/\*[^*]*listening/i);
  assert.doesNotMatch(css, /#orb(\.k3d)?(\.listening|\[data-state="listening"\])[^{]*\{[^}]*214,219,234/, 'no silver left on a listening rule');
});

test('the Knot keeps a dragged position per display and sits upright everywhere', () => {
  assert.match(html, /<div id="app" data-corner="br">/);
  assert.match(css, /#app\[data-corner="tl"\]/, 'data-corner means the quadrant the Knot is in');
  assert.match(css, /#app\[data-corner="tr"\]/);
  assert.doesNotMatch(css, /-webkit-app-region: drag/, 'no OS drag region: the window covers the work area and never moves');
  assert.match(js, /function applyKnotPos\(p, opts = \{\}\)/);
  assert.doesNotMatch(js, /setRotate|function aimKnot/, 'nothing turns the mark: the loose end leaves toward its target');
  assert.match(js, /knot3d\.setDrag\(\{ vx, vy \}\)/, 'it leans with the speed of the hand');
  assert.match(js, /if \(modalOpen\(\) \|\| dragging \|\| fileDragActive\) return true;/, 'the probe never hands the mouse back mid-drag');
  assert.match(js, /if \(suppressClick\) \{ suppressClick = false; return; \}/, 'the release of a drag is not a click');
  assert.match(js, /nus\.on\('knot:pos', applyKnotPayload\)/);
  assert.match(css, /#orb\.k3d, #orb\.k3d:hover, #knot-shell:has\(:focus-visible\) #orb\.k3d, #orb\.k3d:active \{ transform: none; \}/, 'CSS never scales the mark off its thread');
  assert.match(store, /knotCorner: 'br'/, 'the corner stays as the migration source');
  assert.match(store, /knotPos: \{\}/);
  assert.match(main, /companion:knot:pos:set/);
  assert.match(main, /function knotPosPayload\(\)/);
  assert.match(main, /resizable: false,\n    movable: false,/);
  assert.match(main, /function overlayBounds\(\)/);
  assert.match(main, /display-metrics-changed/);
});

test('the whole Knot travels only when it is sent somewhere', () => {
  assert.match(js, /function moveKnotTo\(dest, opts = \{\}\)/);
  assert.match(js, /nus\.on\('knot:move'/);
  assert.match(js, /KSPEC\.host\.skater\.minDistance/, 'a move too short to be a journey just settles');
  assert.match(js, /function clearSpotFor\(rect\)/, 'it steps aside when it sits on its own target');
  assert.match(js, /function endGuide\(after\)/, 'and goes home when the guide ends');
  // A walkthrough step flies there and lassos; Hands, the pill and whole windows keep the thread.
  const target = js.slice(js.indexOf("nus.on('guide:target'"), js.indexOf("nus.on('guide:update'"));
  assert.match(target, /clearSpotFor\(rect\)/);
  assert.match(target, /moveKnotTo\(spotBeside\(rect\), \{ persist: false, keepGuide: true, lasso: rect, region \}\)/);
  assert.match(target, /strand\.setTarget\(rect, \{ task \}\)/);
});

test('guide IPC is allowlisted end to end', () => {
  for (const ch of ['guide:state', 'guide:target', 'guide:update', 'guide:retract', 'guide:bubble', 'guide:done', 'knot:corner', 'knot:pos', 'daily:line']) {
    assert.match(preload, new RegExp(`'${ch}'`), ch + ' reaches the renderer');
  }
  for (const ch of ['companion:guide:ask', 'companion:guide:dismiss', 'companion:guide:keep', 'companion:guide:skip', 'companion:strand:arrived', 'companion:knot:corner:set']) {
    assert.match(preload, new RegExp(ch.replace(/[:]/g, '\\:')), ch + ' is exposed');
    assert.match(main, new RegExp(ch.replace(/[:]/g, '\\:')), ch + ' is handled');
  }
  assert.match(js, /nus\.on\('guide:target'/);
  assert.match(js, /nus\.on\('guide:done'/);
  // The quick pointer: the bubble takes the model's words in place, the thread
  // can come home without ending the session, and arrivals say which target.
  assert.match(js, /nus\.on\('guide:update'/);
  assert.match(js, /nus\.on\('guide:retract'/);
  assert.match(js, /if \(retractOnly\) \{ retractOnly = false; syncSlot\(\); return; \}/, 'a withdrawn quick pick does not tear the bubble down');
  assert.match(js, /nus\.strandArrived\(targetSeq\)/);
  assert.match(main, /guide\.onArrived\(p && p\.seq != null \? p\.seq : undefined\)/);
  assert.match(js, /function dismissGuide\(reason\)/);
  assert.match(js, /e\.key === 'Escape' && guideActive\(\)/, 'Esc winds the thread back');
});

test('dismissal always winds back before the Knot goes idle, and Skip is the default', () => {
  assert.match(js, /strand\.rewind\(\)/);
  assert.match(js, /keepTimer = setTimeout\(\(\) => answerKeep\(false, true\), 12000\)/);
  assert.match(main, /Escape/, 'the harness releases Esc when the thread is home');
  assert.match(main, /CommandOrControl\+Shift\+T/, 'founder harness hotkey');
  assert.match(main, /'commandorcontrol\+shift\+t'/, 'reserved so the ask shortcut cannot take it');
});

test('the acknowledgement is first and nothing cancels it', () => {
  // Composer: the gesture fires at the keypress, before the line closes.
  assert.match(js, /ack\(\);\n\s+closeQuickAsk\(\);\n\s+if \(nus\.guideAsk\) nus\.guideAsk\(\{ text, source: 'typed'/);
  // A dropped file gulps; it does not also acknowledge (one gesture at a time).
  const drop = js.slice(js.indexOf("document.addEventListener('drop'"), js.indexOf('// ---- the strand: guide sessions on screen'));
  assert.match(drop, /knot3d\.gesture\('gulp'\)/);
  assert.doesNotMatch(drop, /\back\(\)/, 'no acknowledge on top of the gulp');
  // Asks that main started still get one.
  assert.match(js, /function ensureAck\(\)/);
  assert.match(js, /nus\.on\('llm:start', \(\{ userBubble, small \}\) => \{\n\s+ensureAck\(\);/);
});

test('one surface by the Knot, on the thread, and the strand holds still under it', () => {
  assert.match(js, /function claimKnotSlot\(el\)/);
  assert.match(js, /function syncSlotThread\(\)/);
  assert.match(js, /strand\.setHeld\(!!onThread && !dragging\)/);
  assert.match(js, /function openSlotSurface\(el, place, opts = \{\}, wait = 0\)/);
  assert.match(js, /if \(solve\) \{ showSurface\(el, place, 'hidden', \{ plain: true \}\); return; \}/, 'assignment mode keeps its gutter stack');
  assert.match(js, /bubble\.offsetLeft \* z/, 'main gets the laid-out bubble rect, not a half-open sliver');
  assert.doesNotMatch(css, /#(guide-bubble|quick-ask|knot-hint|keep-chip) \{[^}]*animation: fadeUp/, 'no base fade left to re-fire');
});
