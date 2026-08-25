// Voice-with-the-Knot contract: regex-over-source assertions that pin the
// security and UI invariants of the voice feature, in the same style as
// ui-contract.test.js.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

const sttLocal = read('src', 'stt-local.js');
const aiJs = read('src', 'ai.js');
const mainJs = read('src', 'main.js');
const preloadJs = read('src', 'preload.js');
const companionIndex = read('companion', 'index.js');
const knot3d = read('companion', 'renderer', 'knot3d.js');
const appJs = read('renderer', 'app.js');
const stylesCss = read('renderer', 'styles.css');
const indexHtml = read('renderer', 'index.html');

test('local STT spawns whisper with bare-transcript flags and no hardcoded user path', () => {
  assert.match(sttLocal, /'-nt'/, 'whisper must run with -nt so stdout is the bare transcript');
  assert.match(sttLocal, /'-np'/);
  assert.ok(!/C:\\\\Users|C:\/Users/i.test(sttLocal), 'no hardcoded user paths in stt-local');
  assert.match(sttLocal, /windowsHide: true/);
});

test('streaming CLI runner keeps the subscription billing rule', () => {
  // Both spawn paths must strip a stray API key so claude -p bills the
  // subscription. Two occurrences: runCli and runCliStream.
  const strips = aiJs.match(/delete env\.ANTHROPIC_API_KEY/g) || [];
  assert.ok(strips.length >= 2, 'runCli AND runCliStream must delete ANTHROPIC_API_KEY');
  assert.match(aiJs, /stream-json/);
});

test('desktop window gets microphone only, never display-capture', () => {
  const branch = companionIndex.match(/if \(isTrustedDesktopWebContents\(webContents\)\) \{[\s\S]*?return ([^;]+);/);
  assert.ok(branch, 'allowMedia must have a desktop branch');
  assert.match(branch[1], /'microphone'/);
  assert.ok(!branch[1].includes('display-capture'), 'the dashboard must never be granted display-capture');
  assert.match(companionIndex, /TRUSTED_DESKTOP_URL/);
});

test('dashboard mic capture never pins a sample rate', () => {
  assert.ok(!/new AudioContext\(\{\s*sampleRate/.test(appJs), 'no sampleRate pin in the dashboard renderer (Windows driver bug)');
  assert.match(appJs, /getUserMedia/);
  assert.match(appJs, /pcm-processor\.js/);
});

test('knot engine has the speaking state and a voice level input', () => {
  assert.match(knot3d, /speaking:\s*\{/);
  assert.match(knot3d, /setLevel\(/);
  assert.match(knot3d, /trefoilPoint/);
});

test('hero styles carry the speaking accent and trace stars', () => {
  assert.match(stylesCss, /\[data-knot='speaking'\]/);
  assert.match(stylesCss, /\.hero-node\.trace/);
  assert.match(stylesCss, /orbBreathe/);
});

test('voice UI is wired end to end', () => {
  assert.match(indexHtml, /id="voice-toggle"/);
  assert.match(indexHtml, /id="voice-thread"/);
  assert.match(preloadJs, /voiceAsk/);
  assert.match(preloadJs, /onAiEvent/);
  assert.match(mainJs, /'voice:ask'/);
  assert.match(mainJs, /'voice:transcribe'/);
  assert.match(appJs, /function renderVoiceThread/);
  assert.match(appJs, /addVoiceTrace/);
});
