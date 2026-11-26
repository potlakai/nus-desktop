// The update and notice channel: a daily signed file, what it can and cannot
// say, the once-a-day and once-per-id rules, and that it never reaches anything
// but plain text and a Nūs link. Design: docs/update-channel.md.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { createChannel, channelConfig, parseManifest, openEnvelope, signEnvelope, safeLink, inRange, PUBLIC_KEYS, CHANNEL_URL } = require('../src/channel');

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const KEYS = { k1: pub };
const cfg = channelConfig({ nusBuild: { channelUrl: 'https://x.test/c.json', channelKeys: KEYS } });
const SHA = 'A'.repeat(86) + '==';
const INSTALLER = v => ({ url: cfg.installerBase + 'companion-v' + v + '/Nus-Companion-Setup.exe', sha512: SHA, size: 200000000 });
const body = (over = {}) => ({ schema: 1, issued_at: '2026-11-10T00:00:00Z', latest: '0.1.16', min_supported: '0.1.5',
  release_url: 'https://github.com/potlakai/nus-desktop/releases/tag/companion-v0.1.16', installer: INSTALLER('0.1.16'), messages: [], ...over });
const msg = (over = {}) => ({ id: 'n1', text: 'Exams soon? Focus guard is one word away.', link: 'https://potlakai.github.io/nus/', versions: { min: '0.1.10' }, ends: '2026-12-31', ...over });

function rig({ current = '0.1.15', file = body(), status = 200, at = '2026-11-10T12:00:00Z', keyName = 'k1', key = privateKey } = {}) {
  const prefs = {};
  let t = Date.parse(at), calls = [];
  const serve = { text: signEnvelope(file, keyName, key), status };
  const fetchImpl = async (url, opts) => { calls.push({ url, opts }); return { ok: serve.status === 200, status: serve.status, text: async () => serve.text }; };
  const c = createChannel({ current, store: { get: k => prefs[k], set: (k, v) => { prefs[k] = v; } }, cfg, fetchImpl, now: () => t, log: () => {} });
  return { c, prefs, calls, serve, tick: ms => { t += ms; } };
}

test('the file is verified whole: tampered, unsigned, wrong-key and unknown-key files all throw', () => {
  const good = signEnvelope(body(), 'k1', privateKey);
  assert.equal(openEnvelope(good, KEYS).latest, '0.1.16');
  const env = JSON.parse(good);
  assert.throws(() => openEnvelope(JSON.stringify({ ...env, body: env.body.replace('0.1.16', '0.1.99') }), KEYS), /bad signature/);
  assert.throws(() => openEnvelope(JSON.stringify(body()), KEYS), /not signed/);
  const other = crypto.generateKeyPairSync('ed25519').privateKey;
  assert.throws(() => openEnvelope(signEnvelope(body(), 'k1', other), KEYS), /bad signature/);
  assert.throws(() => openEnvelope(signEnvelope(body(), 'k9', other), KEYS), /unknown signing key/);
  assert.throws(() => openEnvelope(JSON.stringify({ key: '__proto__', body: '{}', sig: 'AA==' }), KEYS), /unknown signing key/);
  assert.throws(() => openEnvelope('x'.repeat(70 * 1024), KEYS), /too large/);
  assert.throws(() => openEnvelope('not json', KEYS), /not JSON/);
});

test('links go to Nūs places only, over https, on a path boundary', () => {
  assert.ok(safeLink('https://potlakai.github.io/nus/'));
  assert.ok(safeLink('https://potlakai.github.io/nus'));
  assert.ok(safeLink('https://github.com/potlakai/nus-desktop/releases/tag/companion-v0.1.16'));
  for (const bad of ['http://potlakai.github.io/nus/', 'https://potlakai.github.io/nusty', 'https://potlakai.github.io/other', 'https://potlakai.github.io.evil.com/nus',
    'https://evil.com/nus', 'https://potlakai.github.io@evil.com/nus', 'https://x:y@potlakai.github.io/nus', 'https://potlakai.github.io:8443/nus',
    'file:///C:/Windows/System32/calc.exe', 'javascript:alert(1)', 'nus-desktop://x', 'https://github.com/potlakai/other', 'https://github.com/evil/nus-desktop/releases',
    'https://potlakai.github.io/nus/../other', 'https://potlakai.github.io/%6Eus/', '', null, 7, {}]) assert.equal(safeLink(bad), null, String(bad));
});

test('a message carries id, text, link and nothing else; a bad one is dropped and the rest stand', () => {
  const m = parseManifest(body({ messages: [
    msg({ command: 'calc.exe', run: 'powershell', settings: { hands: true }, action: 'open', html: '<b>x</b>' }),
    msg({ id: 'evil id' }),
    msg({ id: 'n2', link: 'https://evil.com/' }),
    msg({ id: 'n3', text: 'line\nbreak' }),
    msg({ id: 'n4', text: 'reversed \u202e text' }),
    msg({ id: 'n5', text: 'x'.repeat(241) }),
    msg({ id: 'n6', ends: 'soon' }),
    msg({ id: 'n7', versions: { min: 'all' } }),
    msg({ id: 'n8', link: undefined }),
  ] }), cfg);
  assert.deepEqual(m.messages.map(x => x.id), ['n1', 'n8']);
  assert.deepEqual(Object.keys(m.messages[0]).sort(), ['ends', 'id', 'link', 'text', 'versions']);
  assert.equal(m.messages[1].link, null);
});

test('the installer must be the release asset of that exact version, with a whole hash and a sane size', () => {
  assert.ok(parseManifest(body(), cfg).installer);
  for (const installer of [{ ...INSTALLER('0.1.16'), url: 'https://evil.com/Nus-Companion-Setup.exe' }, INSTALLER('0.1.15'), { ...INSTALLER('0.1.16'), sha512: 'abc' }, { ...INSTALLER('0.1.16'), size: 5 }, { ...INSTALLER('0.1.16'), size: '200' }, null])
    assert.equal(parseManifest(body({ installer }), cfg).installer, null);
  assert.throws(() => parseManifest({ schema: 2 }, cfg));
  assert.throws(() => parseManifest({ schema: 1 }, cfg), /issued_at/);
  assert.equal(parseManifest(body({ latest: '../../x' }), cfg).latest, null);
});

test('version range is inclusive, and a missing end is open', () => {
  assert.ok(inRange('0.1.10', { min: '0.1.10', max: '0.1.12' }));
  assert.ok(inRange('0.1.12', { min: '0.1.10', max: '0.1.12' }));
  assert.ok(!inRange('0.1.9', { min: '0.1.10' }));
  assert.ok(!inRange('0.1.13', { max: '0.1.12' }));
  assert.ok(inRange('9.9.9', {}));
  assert.ok(!inRange('bad', {}));
});

test('one GET a day that says nothing about the person', async () => {
  const r = rig();
  assert.deepEqual(await r.c.check(), { ok: true, fetched: true });
  await r.c.check();
  assert.equal(r.calls.length, 1);
  const { url, opts } = r.calls[0];
  assert.equal(url, 'https://x.test/c.json');
  assert.equal(opts.method, undefined);
  assert.equal(opts.body, undefined);
  assert.equal(opts.credentials, 'omit');
  assert.equal(opts.headers['User-Agent'], 'nus-companion', 'no version in the request');
  assert.deepEqual(Object.keys(opts.headers).sort(), ['Accept', 'User-Agent']);
  r.tick(86400000);
  await r.c.check();
  assert.equal(r.calls.length, 2);
});

test('an older signed file does not replace a newer one, and a failure keeps what is held', async () => {
  const r = rig();
  await r.c.check();
  r.serve.text = signEnvelope(body({ issued_at: '2026-11-01T00:00:00Z', latest: '0.1.15', messages: [msg()] }), 'k1', privateKey);
  r.tick(86400000);
  assert.equal((await r.c.check()).ok, false);
  assert.equal(r.c.update().version, '0.1.16');
  r.serve.text = 'garbage';
  r.tick(86400000);
  assert.equal((await r.c.check()).ok, false);
  assert.equal(r.c.update().version, '0.1.16');
  r.serve.status = 404;
  r.tick(86400000);
  assert.equal((await r.c.check()).ok, false);
  assert.equal(r.c.update().version, '0.1.16');
});

test('the Knot speaks at most once a day: the update first, once per version, then messages once per id', async () => {
  const r = rig({ file: body({ messages: [msg(), msg({ id: 'n2', text: 'Second.' })] }) });
  await r.c.check();
  const first = r.c.next();
  assert.deepEqual(first, { kind: 'update', version: '0.1.16', oneClick: true, belowMinimum: false });
  r.c.said(first);
  assert.equal(r.c.next(), null, 'one a day');
  r.tick(86400000);
  const second = r.c.next();
  assert.equal(second.id, 'n1');
  assert.deepEqual(Object.keys(second).sort(), ['id', 'kind', 'link', 'text']);
  r.c.said(second);
  r.tick(86400000);
  const third = r.c.next();
  assert.equal(third.id, 'n2');
  r.c.said(third);
  r.tick(86400000);
  assert.equal(r.c.next(), null, 'each id once, the update once');
});

test('the off switch silences the bubble, and a version or end date outside the range is skipped', async () => {
  const r = rig({ current: '0.1.16', file: body({ messages: [msg({ versions: { max: '0.1.15' } }), msg({ id: 'n2', ends: '2026-11-01' }), msg({ id: 'n3' })] }) });
  await r.c.check();
  assert.equal(r.c.next(false), null);
  assert.equal(r.c.next().id, 'n3');
});

test('below min_supported the offer returns once a week; above it, never', async () => {
  const r = rig({ current: '0.1.4' });
  await r.c.check();
  const first = r.c.next();
  assert.equal(first.belowMinimum, true);
  r.c.said(first);
  r.tick(6 * 86400000);
  assert.equal(r.c.next(), null);
  r.tick(86400000);
  assert.equal(r.c.next().kind, 'update');
});

test('no offer when already on the newest; no one-click without a valid installer', async () => {
  const same = rig({ current: '0.1.16' });
  await same.c.check();
  assert.equal(same.c.update(), null);
  const noHash = rig({ file: body({ installer: null }) });
  await noHash.c.check();
  assert.equal(noHash.c.next().oneClick, false);
});

test('a stored file is re-checked field by field on read', async () => {
  const r = rig({ file: body({ messages: [msg()] }) });
  await r.c.check();
  r.prefs.channel.manifest.messages[0].link = 'https://evil.com/';
  assert.equal(r.c.manifest().messages.length, 0);
});

test('the release config has no test block, the real URL is https, and a public key is pinned', () => {
  const cfgFile = require('../../electron-builder.companion.config.js');
  assert.equal(cfgFile.extraMetadata.nusBuild, undefined);
  const real = channelConfig(null);
  assert.equal(real.url, CHANNEL_URL);
  assert.match(CHANNEL_URL, /^https:\/\/potlakai\.github\.io\/nus\//);
  assert.ok(Object.keys(PUBLIC_KEYS).length >= 1);
  for (const k of Object.values(PUBLIC_KEYS)) assert.equal(crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType, 'ed25519');
});

test('the channel module holds no way to run anything or touch a setting', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'channel.js'), 'utf8');
  assert.doesNotMatch(src, /child_process|require\('electron'\)|shell\.|settingsPatch|setSettings|eval\(|new Function/);
  const oneClick = fs.readFileSync(path.join(__dirname, '..', 'src', 'one-click.js'), 'utf8');
  assert.doesNotMatch(oneClick, /require\('electron'\)|settingsPatch|setSettings|eval\(|new Function/);
});

test('wiring: the Knot has fixed buttons, the link stays in the main process, and every open is re-checked', () => {
  const read = f => fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
  const index = read('companion/index.js');
  const main = read('src/main-companion.js');
  const fn = index.slice(index.indexOf('function channelTick()'), index.indexOf('function channelProgress('));
  assert.doesNotMatch(fn, /routeUtterance|applySettingsPatch|setSettings|shell\.|speak:/, 'no route to a task, a setting, the shell or the voice');
  assert.doesNotMatch(fn, /\blink:/, 'the link never goes to the renderer');
  assert.deepEqual([...fn.matchAll(/id === '(nt-[a-z]+)'/g)].map(m => m[1]), ['nt-update', 'nt-page', 'nt-open']);
  assert.match(fn, /__knotSlotFree/, 'never over a composer or an answer');
  assert.match(read('companion/renderer/renderer.js'), /window\.__knotSlotFree = \(\) => !\[bubble, quickAsk, keepChip\]\.some\(\(el\) => isShown\(el\)\)/, 'isShown takes a class as its second argument, so never pass it to some() bare');
  assert.match(index, /\/\^nt-\/\.test\(String\(p\.action\)\)\) \{ channelAction/);
  assert.match(main, /openNotice: item => \{ const url = safeLink\(item && item\.link\); if \(!url\) return;/);
  assert.match(main, /next: enabled => \(tourMod\.shouldShow\(api\.getPreferences\(\)\) \? null : getChannel\(\)\.next\(enabled\)\)/, 'never during the first-run tour');
  assert.match(main, /canRun: app\.isPackaged && process\.platform === 'win32' && !process\.env\.PORTABLE_EXECUTABLE_DIR/);
  assert.match(main, /if \(typeof patch\.channelMessages === 'boolean'\)/, 'the off switch reaches settings');
});
