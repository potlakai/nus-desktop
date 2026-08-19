// Locks the UI decisions that are easy to undo by accident:
// Map stays a top-level rail item, Jarvis carries the history view, the
// Companion keeps its Knot and its three hide levels, and the vault upload
// keeps its preview step.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const appJs = read('renderer/app.js');
const indexHtml = read('renderer/index.html');
const companionIndex = read('companion/index.js');
const companionHtml = read('companion/renderer/index.html');
const companionCss = read('companion/renderer/styles.css');
const companionJs = read('companion/renderer/renderer.js');

test('the rail is config-driven with Map at the top level', () => {
  const block = appJs.slice(appJs.indexOf('const rail = ['), appJs.indexOf('const viewParent = {}'));
  assert.match(block, /\{ view: 'brain', label: 'Map' \}/, 'Map is its own top-level entry');
  // Map must not be nested under any parent's children.
  assert.ok(!/children:[^\]]*'brain'/.test(block), 'Map is not buried in a children array');
  const order = [...block.matchAll(/view: '([a-z]+)', label:/g)].map((m) => m[1]);
  assert.equal(order[0], 'today');
  assert.equal(order[1], 'brain', 'Map sits directly under Today');
});

test('Knot groups the Companion and its History; Connections owns the wiring', () => {
  const block = appJs.slice(appJs.indexOf('const rail = ['), appJs.indexOf('const viewParent = {}'));
  assert.match(block, /label: 'Knot'[\s\S]*?\['history', 'History'\]/);
  assert.match(block, /label: 'Connections'[\s\S]*?\['integrations', 'Integrations'\]/);
  assert.ok(!/label: 'Jarvis'/.test(block), 'the rail no longer says Jarvis');
  assert.match(block, /\{ view: 'email', label: 'Email' \}/, 'Email is its own top-level rail item');
  assert.ok(!/children:[^\]]*'email'/.test(block), 'Email is not buried in a children array');
  assert.match(indexHtml, /id="view-history"/);
  assert.match(indexHtml, /id="view-companion"/);
});

test('the constellation hero exists and the 3D knot is shared', () => {
  assert.match(indexHtml, /id="hero-field"/);
  assert.match(indexHtml, /id="hero-knot"/);
  assert.match(indexHtml, /companion\/renderer\/knot3d\.js/, 'desktop loads the shared renderer');
  assert.match(appJs, /function renderConstellation/);
  assert.match(appJs, /hero-node attention|attention'/, 'attention signal wired');
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'companion/renderer/knot3d.js')));
});

test('the dashboard carries the mini calendar, todo, and connections cards', () => {
  assert.match(indexHtml, /id="mini-calendar"/);
  assert.match(indexHtml, /id="todo-list"/);
  assert.match(indexHtml, /id="connections-row"/);
  assert.match(appJs, /function renderMiniCalendar/);
  assert.match(appJs, /function renderTodo/);
  assert.match(appJs, /function renderConnections/);
});

test('Ask Nūs works from every view and knows the app guide', () => {
  assert.match(indexHtml, /id="global-ask"/);
  assert.match(appJs, /const APP_GUIDE=\[/);
  assert.match(appJs, /function guideAnswer/);
  assert.match(indexHtml, /id="draft-fill"/, 'email has Ask Nūs to fill');
});

test('the old sub-nav pill row is gone, replaced by inline rail children', () => {
  assert.ok(!indexHtml.includes('id="subnav"'), 'no #subnav element');
  assert.ok(!appJs.includes("$('#subnav')"), 'no #subnav wiring');
  assert.match(appJs, /class="nav-children"/);
});

test('the History view is no longer a toast stub', () => {
  assert.ok(!appJs.includes('Full history ships in an update'), 'stub copy removed');
  assert.match(appJs, /\$\('#view-history'\)\.addEventListener\('click',\(\)=>setView\('history'\)\)/);
});

test('vault upload previews before it writes', () => {
  // The write call must only be reachable from the confirm button.
  assert.match(appJs, /companionVaultPreview/);
  assert.match(appJs, /\$\('#vault-confirm'\)\.onclick/);
  const previewIdx = appJs.indexOf('companionVaultPreview');
  const writeIdx = appJs.indexOf('companionVaultWrite');
  assert.ok(previewIdx < writeIdx, 'preview is wired before write');
  assert.match(indexHtml, /id="vault-body"/);
});

test('the Companion keeps the Knot and drops the retired statue orb', () => {
  assert.match(companionHtml, /class="nus-knot"/);
  assert.ok(!companionHtml.includes('nus-statue-mark.png'), 'statue mark removed from the overlay');
  for (const state of ['idle', 'listening', 'thinking', 'ready']) {
    assert.match(companionHtml, new RegExp(`data-knot-state="${state}"`), `${state} control present`);
  }
  assert.match(companionJs, /function syncKnotUi/);
});

test('dead orb code and its orphaned styles are gone', () => {
  assert.ok(!companionJs.includes('makeOrb'), 'unreachable canvas orb removed');
  assert.ok(!companionCss.includes('#orb-canvas'), 'canvas styles removed');
  assert.ok(!companionCss.includes('.thought-fissure'), 'shard styles removed');
  assert.ok(!companionCss.includes('.statue-orb'), 'statue styles removed');
  assert.ok(!fs.existsSync(path.join(__dirname, '..', 'companion/renderer/assets/nus-statue-mark.png')));
});

test('Knot colors tween through a custom property instead of hard swaps', () => {
  assert.match(companionCss, /--knot-accent/);
  assert.match(companionCss, /stroke: var\(--knot-accent/);
  assert.match(companionCss, /transition: stroke [\d.]+s ease/);
});

test('the marble-era surface blurs are gone; scrim blurs may stay', () => {
  const surfaceBlur = /backdrop-filter:\s*blur\((?:[2-9]\d)px\)/; // 20px+
  assert.ok(!surfaceBlur.test(companionCss), 'no heavy backdrop blur on any surface');
});

test('the 3D knot renderer is mounted and the overlay boots clean', () => {
  assert.match(companionHtml, /id="knot-canvas"/);
  assert.match(companionHtml, /knot3d\.js/);
  assert.match(companionJs, /NusKnot3D\.mount/);
  assert.ok(!companionJs.includes('showExample'), 'no fake conversation at boot');
  const knot3d = read('companion/renderer/knot3d.js');
  assert.match(knot3d, /trefoilPoint/);
  assert.match(knot3d, /prefers-reduced-motion/, 'reduced motion handled, not ignored');
});

test('Think preflights the provider instead of flipping to Ready', () => {
  assert.match(companionJs, /nus\.aiReady/);
  const companionMain = read('companion/index.js');
  assert.match(companionMain, /companion:ai:ready/);
  assert.match(companionMain, /send\('llm:busy'/, 'busy rejection reaches the renderer');
});

test('the guide mode exists and works without a provider', () => {
  const prompts = read('companion/src/prompts.js');
  assert.match(prompts, /guide: \{/);
  const companionMain = read('companion/index.js');
  assert.match(companionMain, /mode === 'guide'/);
  assert.match(companionMain, /getDesktopState/);
  const nusContext = read('companion/src/nus-context.js');
  assert.match(nusContext, /renderNusSummary/, 'summary render, not raw JSON slice');
  assert.match(nusContext, /normalize\('NFC'\)/);
});

test('the tutorials link to each other', () => {
  assert.match(companionJs, /desktopTour/);
  assert.match(companionJs, /nus\.on\('tour:start'/);
  assert.match(appJs, /onDesktopTour/);
  assert.match(appJs, /companionControl\?\.\('tour'\)/);
});

test('all three hide levels exist, with a way back that does not need a hotkey', () => {
  assert.match(companionIndex, /globalShortcut\.register\('CommandOrControl\+Shift\+Space', toggleOverlay\)/);
  assert.match(companionIndex, /globalShortcut\.register\('CommandOrControl\+Shift\+K', toggleKnot\)/);
  assert.match(companionIndex, /globalShortcut\.register\('CommandOrControl\+Shift\+X', panicHide\)/);
  assert.match(companionIndex, /function forceShow/, 'desktop can always force the overlay back');
  assert.match(companionCss, /#toolbar\.knot-hidden #knot-shell \{ display: none; \}/);
  // Panic must stop capture, not just hide the window.
  const panic = companionIndex.slice(companionIndex.indexOf('function panicHide'));
  assert.match(panic.slice(0, 300), /setCapturing\(false\)/);
});

test('the CLI spawn never inherits an API key and errors leave a trail', () => {
  const aiJs = read('src/ai.js');
  assert.match(aiJs, /delete env\.ANTHROPIC_API_KEY/, 'CLI bills the subscription, never a stray env key');
  assert.match(aiJs, /ai-errors\.log/, 'AI errors are logged to userData');
  assert.match(appJs, /function aiError\(code,detail\)/, 'error detail reaches the toast');
});

test('the Knot mark state is persisted and restorable from the desktop', () => {
  const store = read('companion/src/store.js');
  assert.match(store, /knotHidden: false/, 'knot visibility is persisted, default visible');
  assert.match(companionIndex, /knotHidden/, 'status reports knot visibility');
  assert.match(companionIndex, /busy: Boolean\(state\.busy\)/, 'status reports busy so Thinking can light');
  assert.match(indexHtml, /id="companion-knot"/, 'desktop can restore the Knot mark without the hotkey');
  assert.match(companionJs, /knot:set/, 'overlay applies the persisted state idempotently');
});

test('the desktop Knot pane carries a persistent chat thread', () => {
  assert.match(indexHtml, /id="chat-thread"/);
  assert.match(indexHtml, /id="chat-input"/);
  assert.match(appJs, /nus-chat/, 'chat history survives restarts');
  const mainJs = read('src/main.js');
  assert.match(mainJs, /'chat:send'/, 'chat IPC exists');
});

test('the Companion outlives the dashboard and can be removed from it', () => {
  const store = read('companion/src/store.js');
  const mainJs = read('src/main.js');
  assert.match(store, /companionEnabled: true/, 'the Companion ships on and its state persists');
  assert.match(companionIndex, /function disableCompanion/, 'the Companion can be fully removed');
  assert.match(companionIndex, /function enableCompanion/, 'and brought back');
  // Closing the dashboard must not kill a live Companion.
  assert.match(mainJs, /if \(!companion \|\| !companion\.isEnabled\(\)\) app\.quit\(\)/, 'window close respects a live Companion');
  assert.ok(!/app\.on\('window-all-closed', \(\) => app\.quit\(\)\)/.test(mainJs), 'no unconditional quit on window-all-closed');
  assert.match(mainJs, /case 'disable'/, 'desktop can disable the Companion');
  assert.match(indexHtml, /id="companion-power"/, 'the desktop carries the on/off control');
  // Turning it off must release the global hotkeys, not just hide the window.
  const disable = companionIndex.slice(companionIndex.indexOf('function disableCompanion'));
  assert.match(disable.slice(0, 420), /globalShortcut\.unregisterAll\(\)/);
  assert.match(disable.slice(0, 420), /setCapturing\(false\)/);
});

test('the CLI runs a pinned model, not the user most expensive default', () => {
  const aiJs = read('src/ai.js');
  assert.match(aiJs, /'--model', MODEL/, 'the spawn pins the model');
  assert.match(aiJs, /const MODEL = 'claude-sonnet-5'/, 'and it is the mid-tier one');
  assert.match(aiJs, /cli_spend_limit/, 'a spend cap is reported as its own fixable case');
});

test('Gmail works with no connection and never guesses the sending address', () => {
  const mainJs = read('src/main.js');
  assert.match(mainJs, /'mail:gmail-compose'/);
  assert.match(mainJs, /authuser=/, 'the compose is pinned to the chosen account');
  assert.match(indexHtml, /id="email-account-list"/, 'addresses are managed in the Email tab');
  assert.match(indexHtml, /id="draft-from"/, 'the draft says which address it sends from');
  assert.match(appJs, /data-wiz-from=/, 'the Ask wizard offers the saved addresses');
});

test('the constellation repaints when the DOM is empty, cache or not', () => {
  // A key-only guard once left the hero blank permanently.
  assert.match(appJs, /painted===items\.length/, 'the paint guard checks the DOM, not just the key');
});

test('the Companion answers app questions from the guide, not a screenshot', () => {
  assert.match(companionIndex, /const APP_GUIDE =/);
  assert.match(companionIndex, /mode === 'guide' \|\| mode === 'assist' \|\| mode === 'ask'/, 'typed questions get the guide too');
});

test('the Companion capsule cannot be clipped by the stack that holds it', () => {
  // #stack hides overflow and is only as wide as #toolbar, so the toolbar has
  // to be at least as wide as the absolutely positioned bloom's right edge.
  const width = (re) => Number((companionCss.match(re) || [])[1]);
  const bloomLeft = width(/#knot-bloom \{[^}]*left: (\d+)px/);
  const bloomWidth = width(/#knot-bloom \{[^}]*width: (\d+)px/);
  const toolbarMin = width(/#toolbar \{[\s\S]*?min-width: min\((\d+)px/);
  assert.ok(bloomLeft && bloomWidth && toolbarMin, 'all three sizes are readable');
  assert.ok(toolbarMin >= bloomLeft + bloomWidth, `toolbar ${toolbarMin} must cover bloom right edge ${bloomLeft + bloomWidth}`);
});

test('both API keys are reachable from the desktop app and explained', () => {
  const mainJs = read('src/main.js');
  assert.match(mainJs, /'companion:ai:set-key'/, 'the Companion key is settable from the desktop');
  assert.match(indexHtml, /id="companion-ai-card"/, 'and has its own Settings card');
  assert.match(indexHtml, /id="rail-storage"/, 'storage shows in the rail');
  const tour = appJs.slice(appJs.indexOf('const tourSteps=['), appJs.indexOf('let focusPicked='));
  assert.match(tour, /Key 1 of 2/, 'the tour covers the desktop key');
  assert.match(tour, /Key 2 of 2/, 'and the Companion key');
  assert.match(tour, /Ctrl\+Shift\+Space/, 'and the Companion commands');
});

test('click-through has exactly one state, so the overlay cannot latch dead', () => {
  // Two setters over two variables let the window say "click-through on" while
  // the guard still believed it was off, and the overlay stopped taking clicks
  // for good after the settings panel was closed once.
  assert.ok(!/function setIgnore\(v\) \{ if \(v !== ignoring\)/.test(companionJs), 'the second, competing setter is gone');
  assert.match(companionJs, /const setIgnore = setIgnoreSafe/, 'one setter, aliased');
  const safe = companionJs.slice(companionJs.indexOf('function setIgnoreSafe'));
  assert.match(safe.slice(0, 260), /if \(v === ignoring\) return;/, 'the single setter owns the guard');
  assert.match(companionJs, /function modalOpen/, 'an open modal always owns the mouse');
  assert.match(companionJs, /function openSettings\(\)[^\n]*setIgnoreSafe\(false\)/, 'opening settings takes the mouse at once');
});

test('stealth ships off and is the only thing that hides the tray', () => {
  const store = read('companion/src/store.js');
  assert.match(store, /stealth: false/, 'stealth defaults off');
  assert.match(companionIndex, /settings\.stealth === true\) destroyTray\(\)/);
});

test('the companion preload namespaces every channel it can invoke', () => {
  const preload = read('companion/preload.js');
  const invokes = [...preload.matchAll(/ipcRenderer\.(?:invoke|send)\('([^']+)'/g)].map((m) => m[1]);
  assert.ok(invokes.length > 5);
  for (const channel of invokes) {
    assert.ok(channel.startsWith('companion:'), `${channel} must be namespaced`);
  }
});

test('the tour teaches the nav that actually exists', () => {
  const tour = appJs.slice(appJs.indexOf('const tourSteps=['), appJs.indexOf('let focusPicked='));
  assert.match(tour, /rail:'brain'/, 'tour points at Map as a rail item');
  assert.match(tour, /view:'companion'/);
  assert.match(tour, /view:'history'/);
  assert.ok(!tour.includes("pill at the bottom of the canvas flips"), 'stale sub-nav instructions removed');
});

test('no em dashes remain in user-facing copy', () => {
  const DASH = String.fromCharCode(8212);
  // The GPA / missing-value placeholder glyph is a UI dash, not prose.
  const placeholders = [`'${DASH}'`, `"${DASH}"`];
  for (const [name, src] of [['app.js', appJs], ['index.html', indexHtml]]) {
    for (const line of src.split('\n')) {
      if (!line.includes(DASH)) continue;
      assert.ok(placeholders.some((p) => line.includes(p)),
        `${name} has a prose em dash: ${line.trim().slice(0, 120)}`);
    }
  }
});

test('the mic path never forces a sample rate the driver can reject', () => {
  const worklet = read('companion/renderer/pcm-processor.js');
  assert.match(worklet, /targetRate/, 'worklet downsamples to the target itself');
  assert.match(worklet, /level/, 'worklet reports RMS for the voice wave');
  // The renderer must not construct a rate-pinned context: that is what made
  // capture silently produce nothing on Windows.
  assert.ok(!/new AudioContext\(\{\s*sampleRate/.test(companionJs), 'no rate-pinned AudioContext');
  assert.match(companionJs, /getUserMedia/);
  assert.match(companionJs, /NotAllowedError/, 'permission denial is explained, not swallowed');
});

test('the listening state shows a live voice wave', () => {
  assert.match(companionHtml, /id="voice-wave"/);
  assert.match(companionJs, /function pushLevel/);
  assert.match(companionJs, /function startWave/);
  assert.match(companionCss, /\.voice-wave/);
});

test('no personal briefing slug can reach a downloaded build', () => {
  const store = read('companion/src/store.js');
  // Auto-discovery only runs when the dev explicitly points at a vault.
  assert.match(store, /JARVIS_VAULT \|\| null/);
  assert.match(store, /if \(!VAULT\) return null/);
  const mainJs = read('src/main.js');
  assert.ok(!/pack: \$\{meta\.pack\}/.test(mainJs), 'activity log never prints the slug');
  // Built from pieces so the guarded name never appears in this repo either.
  const personal = new RegExp(['ak', 'rit'].join(''), 'i');
  for (const [name, src] of [['app.js', appJs], ['main.js', mainJs]]) {
    assert.ok(!personal.test(src), `${name} carries no personal pack name`);
    // A home directory baked into a shipped binary is the other way this leaks.
    assert.ok(!/[A-Za-z]:\\\\Users\\\\[a-z]/i.test(src), `${name} hardcodes no home directory`);
  }
});
