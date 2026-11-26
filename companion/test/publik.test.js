'use strict';
// Sign in with publik (companion/src/publik): what Publik's scan reads, the gate's place at
// start-up, the one build switch, the publik provider, and the words of a publik error.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('the module file carries what Publik\'s scan reads, in code', () => {
  const src = read('companion/src/publik/publik.js');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  for (const s of ['/api/v1/installs', '/api/v1/telemetry', 'app_opened', 'APP_SLUG = "nus"']) assert.ok(code.includes(s), s);
});

test('the module version is the build version', () => {
  const mod = require('../src/publik/publik');
  const cfg = require('../../electron-builder.companion.config.js');
  assert.equal(mod.APP_VERSION, cfg.extraMetadata.version);
  assert.equal(mod.APP_SLUG, 'nus');
});

test('the gate is the first thing at start-up after the exam check, before any screen', () => {
  const main = read('src/main-companion.js');
  const ready = main.indexOf('app.whenReady().then(');
  const gate = main.indexOf('publik.module.ensureSignedIn(', ready);
  assert.ok(ready > 0 && gate > ready, 'gate inside whenReady');
  const exam = main.indexOf('standDown(exam); return;', ready);
  assert.ok(exam > 0 && exam < gate, 'the exam stand-down comes first');
  for (const later of ["open(path.join(userData, 'data'))", 'companionApp.initCompanion(', 'openHome();']) {
    const at = main.indexOf(later, ready);
    assert.ok(at > gate, later + ' comes after the gate');
  }
  // No way past it: the gate call is not behind a smoke, dev or environment check.
  const block = main.slice(main.lastIndexOf('if (publik) {', gate), gate);
  assert.doesNotMatch(block, /SMOKE|isPackaged|process\.env/);
});

test('one build switch: on in the release config, off in a plain development start', () => {
  const cfg = require('../../electron-builder.companion.config.js');
  assert.equal(cfg.extraMetadata.publik, true);
  assert.ok(cfg.files.includes('publik-app-token.txt'), 'the app token ships in the asar');
  assert.ok(!cfg.files.includes('!companion/src/publik/**'));
  const saved = process.env.NUS_PUBLIK; delete process.env.NUS_PUBLIK;
  try { assert.equal(require('../src/publik').on(), false); } finally { if (saved !== undefined) process.env.NUS_PUBLIK = saved; }
});

test('the switch is the only way in: off, createLLM keeps the own-key path', () => {
  const saved = { a: process.env.NUS_PUBLIK, k: process.env.PUBLIK_API_KEY };
  delete process.env.NUS_PUBLIK; process.env.PUBLIK_API_KEY = 'pk_live_test_only';
  try {
    const { createLLM } = require('../src/llm');
    const llm = createLLM({ provider: 'gemini', apiKeys: { gemini: 'g' }, models: { gemini: { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' } } });
    assert.equal(llm.provider, 'gemini');
  } finally { restore(saved); }
});

test('switch on and publik chosen: the publik provider, tier names only', () => {
  const saved = { a: process.env.NUS_PUBLIK, k: process.env.PUBLIK_API_KEY };
  process.env.NUS_PUBLIK = '1'; process.env.PUBLIK_API_KEY = 'pk_live_test_only';
  try {
    const { createLLM } = require('../src/llm');
    const settings = { provider: 'gemini', apiKeys: {}, models: { gemini: { fast: 'gemini-3.6-flash', smart: 'gemini-3.6-pro' } } };
    const fast = createLLM(settings);
    assert.equal(fast.provider, 'publik'); assert.equal(fast.ready, true); assert.equal(fast.model, 'publik-fast');
    assert.equal(createLLM({ ...settings, smart: true }).model, 'publik-smart');
    const pub = require('../src/publik');
    assert.equal(pub.model('fast', 'gemini-3.6-pro'), 'publik-fast', 'a vendor name is never sent');
    assert.equal(pub.model('fast', 'publik-balanced'), 'publik-balanced');
  } finally { restore(saved); }
});

test('an empty balance (402): Publik\'s message, one line, and the one top-up link', () => {
  const pub = require('../src/publik');
  const e = Object.assign(new Error('402 Not enough publik API balance.'), { status: 402, error: { message: 'Not enough publik API balance.', top_up_url: 'https://publikhq.com/wallet?top_up=1' } });
  const r = pub.readError(e);
  assert.equal(r.kind, 'balance'); assert.equal(r.url, 'https://publikhq.com/wallet?top_up=1');
  const { plainAskError } = require('../src/ask-error');
  const line = plainAskError('publik', e);
  // 0.1.22: the line names publik's free week (card, paid after) before the own-key way out.
  assert.match(line, /^Not enough publik API balance\. publik gives new subscribers a free week: it needs a card and is paid after the week unless you cancel\. Or keep going for free with your own key: a free Gemini key works\./);
  assert.match(line, /Voice commands and reminders still work/);
  assert.doesNotMatch(line, /https?:/, 'the link rides on the Top up button, not in the text');
});

test('publik offline and signed out read as plain words', () => {
  const pub = require('../src/publik');
  assert.match(pub.errorLine(Object.assign(new Error('Connection error.'), { name: 'APIConnectionError' })), /^publik is not reachable\. Check your connection\./);
  assert.match(pub.errorLine(Object.assign(new Error('401'), { status: 401 })), /Restart Nūs to sign in again/);
  assert.equal(pub.errorLine(new Error('something else')), '');
});

test('the gate window draws Publik\'s words exactly, with the Nūs lines above them', () => {
  const mod = require('../src/publik/publik');
  const { view, WORDING, WORDING_PICK, UPDATING, CHOICE_LINE } = require('../src/publik/gate-window');
  const sign = mod.gateScreen('sign_in', null);
  const v = view(sign, { updating: true });
  assert.equal(v.title, sign.title); assert.equal(v.body, sign.body); assert.deepEqual(v.buttons.map((b) => b.label), ['Sign in with publik']);
  const w = WORDING[WORDING_PICK];
  assert.deepEqual(v.nus, [w.headline, w.line, w.callout, ...v.steps, UPDATING].filter(Boolean));
  assert.equal(view(sign, { updating: false }).updating, '');
  const choose = view(mod.gateScreen('choose', { claim_state: 'claimed', account: null, plan: { kind: 'none', label: null }, balance_micros: 50000, top_up_url: 'x' }));
  assert.deepEqual(choose.buttons.map((b) => b.label), ['Connect your plan', 'Use my own key']);
  assert.equal(choose.privacy, CHOICE_LINE);
  const off = view(mod.gateScreen('unreachable', null));
  assert.equal(off.body, 'publik is not reachable. Check your connection.');
  assert.deepEqual(off.buttons.map((b) => b.label), ['Retry']);
  for (const line of [UPDATING, CHOICE_LINE]) assert.doesNotMatch(line, /—/, 'no em dashes');
});

test('big screenshots shrink under Publik\'s 4 MB limit only when needed', () => {
  const pub = require('../src/publik');
  const small = 'data:image/png;base64,' + 'A'.repeat(1000);
  assert.equal(pub.prepareImage(small), small);
});

function restore(saved) {
  if (saved.a === undefined) delete process.env.NUS_PUBLIK; else process.env.NUS_PUBLIK = saved.a;
  if (saved.k === undefined) delete process.env.PUBLIK_API_KEY; else process.env.PUBLIK_API_KEY = saved.k;
}

// 2026-11-16: a tester's Mac stayed signed in to the developer's publik account, and the only way
// out was deleting a file by hand. Settings, Keys now says who is signed in and signs out.
test('signing out of publik forgets this computer\'s key and nothing else', () => {
  const { spawnSync } = require('child_process');
  const os = require('os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-publik-'));
  const script = `
    const fs = require('fs'), path = require('path');
    const p = require(${JSON.stringify(path.join(ROOT, 'companion', 'src', 'publik'))});
    const file = p.module.credentialPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ key: 'pk_test_abcdef', install_id: 'i1', choice: 'publik' }));
    const other = path.join(path.dirname(file), 'other-app.json'); fs.writeFileSync(other, '{"key":"pk_other"}');
    const before = !!p.module.readCredential(), activeBefore = p.active();
    const ok = p.signOut();
    console.log(JSON.stringify({ before, activeBefore, ok, after: p.module.readCredential(), activeAfter: p.active(), choice: p.choice(), otherKept: fs.readFileSync(other, 'utf8'), again: p.signOut() }));
  `;
  const env = { ...process.env, NUS_PUBLIK: '1', LOCALAPPDATA: dir, XDG_CONFIG_HOME: dir, HOME: dir, USERPROFILE: dir };
  delete env.PUBLIK_API_KEY;
  const r = spawnSync(process.execPath, ['-e', script], { env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out, { before: true, activeBefore: true, ok: true, after: null, activeAfter: false, choice: null, otherKept: '{"key":"pk_other"}', again: true });
  // A key handed in by the environment (development) is not ours to forget.
  const dev = spawnSync(process.execPath, ['-e', `const p = require(${JSON.stringify(path.join(ROOT, 'companion', 'src', 'publik'))}); console.log(p.signOut());`], { env: { ...env, PUBLIK_API_KEY: 'pk_env' }, encoding: 'utf8' });
  assert.equal(dev.stdout.trim(), 'false');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('Settings, Keys names the publik account and signs out in two taps, then Nūs restarts', () => {
  const main = read('src/main-companion.js'), html = read('companion/home/index.html'), js = read('companion/home/home.js'), pre = read('companion/home/preload.js');
  assert.match(main, /handle\('home:publik:who', async \(\) => \(publik \? publik\.who\(\) : null\)\);/);
  assert.match(main, /handle\('home:publik:signout', \(\) => \{\s*if \(!publik \|\| !publik\.signOut\(\)\) return \{ ok: false \};\s*setTimeout\(\(\) => \{ app\.relaunch\(\); app\.quit\(\); \}, 900\);/);
  assert.match(pre, /publikWho: \(\) => invoke\('publik:who'\), publikSignOut: \(\) => invoke\('publik:signout'\)/);
  assert.match(html, /id="publik-signout" class="quiet" type="button">Sign out of publik</);
  assert.match(html, /sign out of publikhq\.com in your browser first/);
  // The first tap only says what will happen; the second one signs out.
  assert.match(js, /if\(e\.currentTarget\.dataset\.armed!=='1'\)\{publikSignOutArmed\(true\);return;\}/);
  assert.match(js, /'Signed in with publik as '\+w\.handle\+'\.'/);
});
