'use strict';
// The first-run hello (companion/src/hello.js): the Knot types into a Notepad window it opened,
// live, then asks to show more. These tests drive the run with a fake Notepad and a fake helper,
// and check the safety rules: only its own window, only while in front, only into an empty
// document, stop the moment the person acts, and never save or close anything.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('../src/hello');
const T = require('../src/tour');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// A fake desktop: Notepad comes up after `upAfter` looks; `doc` is the open document's text, or
// null when it cannot be read; `stopAt` makes the helper stop after that many characters.
function desk(o = {}) {
  const calls = { slow: [], press: [], launched: 0 };
  let looks = 0, clock = 0, doc = o.doc === undefined ? '' : o.doc, typed = '';
  const pad = { hwnd: 77, process: o.process || 'Notepad', title: 'Untitled - Notepad' };
  return {
    calls, get typed() { return typed; },
    deps: {
      launch: () => { calls.launched++; if (o.launchThrows) throw new Error('no notepad'); },
      front: async () => { looks++; return looks > (o.upAfter || 0) ? (o.front ? o.front(looks) : pad) : { hwnd: 5, process: 'Code' }; },
      slow: async (a) => {
        calls.slow.push(a);
        if (a.hwnd !== 77) return { ok: false, stopped: 'gone', typed: 0 };
        if (a.requireEmpty) { if (doc === null) return { ok: true, typed: 0, empty: null }; if (doc.trim()) return { ok: false, stopped: 'not_empty', typed: 0, empty: false }; return { ok: true, typed: 0, empty: true }; }
        let n = 0;
        for (const c of a.text) {
          if (o.stopAt != null && typed.length >= o.stopAt) return { ok: false, stopped: o.stopWhy || 'focus', typed: n };
          typed += c; n++;
        }
        return { ok: true, typed: n };
      },
      press: async (keys, hwnd) => { calls.press.push({ keys, hwnd }); if (o.newTabEmpty !== false) doc = ''; },
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
      win11: o.win11 !== false,
      pos: o.pos || { fx: 0.92, fy: 0.9 },
      aborted: o.aborted || (() => false),
    },
  };
}

test('the words: GPT\'s version by default, Pranav\'s own as the other, and the corner where the Knot is', () => {
  assert.equal(H.STUNT_PICK, 'A');
  assert.equal(H.text('A', { fx: 0.9, fy: 0.9 }), "You didn't open this.\nI did.\n\nI'm Nūs!\n\nLook at the bottom-right corner of your screen.");
  assert.equal(H.text('B', { fx: 0.9, fy: 0.9 }), 'Welcome to Nūs. Please look at the Knot at the bottom right corner to begin');
  assert.match(H.text('A', { fx: 0.1, fy: 0.1 }), /top-left corner/);
  assert.match(H.text('A', { fx: 0.1, fy: 0.8 }), /bottom-left corner/);
  assert.match(H.text('A', { island: true }), /Look at the top of your screen\.$/);
  for (const k of Object.keys(H.STUNTS)) assert.doesNotMatch(H.text(k, {}), /—/);
});

test('a fresh Notepad: the whole note typed, line by line, into that window only', async () => {
  const d = desk();
  const r = await H.run(d.deps);
  assert.equal(r.outcome, 'finished');
  assert.equal(d.typed, H.text('A', { fx: 0.92, fy: 0.9 }));
  assert.ok(d.calls.slow.every((a) => a.hwnd === 77), 'only the Notepad it found in front');
  assert.ok(d.calls.slow.filter((a) => a.text).every((a) => a.delayMs === H.CHAR_MS), 'typed live');
  assert.ok(d.calls.slow.filter((a) => a.text).length >= 5, 'a line at a time');
  assert.equal(d.calls.press.length, 0, 'an empty document needs no new tab');
});

test('Windows 11 brought back the person\'s own tab: a new tab first, and only then the note', async () => {
  const d = desk({ doc: 'my shopping list' });
  const r = await H.run(d.deps);
  assert.equal(r.outcome, 'finished');
  assert.deepEqual(d.calls.press, [{ keys: 'ctrl+n', hwnd: 77 }]);
  const firstType = d.calls.slow.findIndex((a) => a.text);
  assert.ok(d.calls.slow.slice(0, firstType).filter((a) => a.requireEmpty).length === 2, 'checked empty again after the new tab');
});

test('the new tab is still not empty, or it is Windows 10: nothing typed at all', async () => {
  const stuck = desk({ doc: 'notes', newTabEmpty: false });
  assert.equal((await H.run(stuck.deps)).outcome, 'skipped'); assert.equal(stuck.typed, '');
  const ten = desk({ doc: 'notes', win11: false });
  const r = await H.run(ten.deps);
  assert.equal(r.outcome, 'skipped'); assert.equal(ten.typed, ''); assert.equal(ten.calls.press.length, 0, 'no Ctrl+N on the old Notepad: it would ask to save');
});

test('a document that cannot be read on Windows 11 gets a new tab first, to be safe', async () => {
  const d = desk({ doc: null });
  assert.equal((await H.run(d.deps)).outcome, 'finished');
  assert.equal(d.calls.press.length, 1);
});

test('Notepad opens behind: it is brought forward, then the same checks, then the note', async () => {
  let nudged = 0;
  const d = desk({ front: () => (nudged ? { hwnd: 77, process: 'Notepad' } : { hwnd: 5, process: 'claude' }) });
  d.deps.nudge = async () => { nudged++; };
  const r = await H.run(d.deps);
  assert.equal(nudged, 1); assert.equal(r.outcome, 'finished');
  const never = desk({ upAfter: 1e9 }); let tries = 0; never.deps.nudge = async () => { tries++; };
  assert.equal((await H.run(never.deps)).outcome, 'skipped'); assert.equal(tries, 2, 'twice at most'); assert.equal(never.calls.slow.length, 0);
});

test('focus moves away just before the first character: Notepad is brought back once, the same window, then the note', async () => {
  const d = desk(); let first = true, nudged = 0;
  const slow = d.deps.slow;
  d.deps.slow = async (a) => { if (first && a.requireEmpty) { first = false; return { ok: false, stopped: 'focus', typed: 0 }; } return slow(a); };
  d.deps.nudge = async () => { nudged++; };
  assert.equal((await H.run(d.deps)).outcome, 'finished'); assert.equal(nudged, 1);
  // Brought back, but a different window is in front: nothing typed.
  const e = desk({ front: (n) => (n === 1 ? { hwnd: 77, process: 'Notepad' } : { hwnd: 78, process: 'Notepad' }) });
  e.deps.slow = async (a) => (a.requireEmpty ? { ok: false, stopped: 'focus', typed: 0 } : { ok: true, typed: a.text.length });
  e.deps.nudge = async () => {};
  const r = await H.run(e.deps);
  assert.equal(r.outcome, 'skipped'); assert.equal(r.typed, 0);
});

test('Notepad never comes to the front, or does not start: nothing typed, the Knot goes on', async () => {
  const never = desk({ upAfter: 1e9 });
  const r = await H.run(never.deps);
  assert.equal(r.outcome, 'skipped'); assert.equal(never.calls.slow.length, 0);
  assert.equal(r.why, 'notepad never came to the front (in front: Code)', 'the log says what was in front');
  const blind = desk(); blind.deps.front = async () => null;
  assert.equal((await H.run(blind.deps)).why, 'the window helper could not say which window is in front');
  const none = desk({ launchThrows: true });
  assert.equal((await H.run(none.deps)).outcome, 'skipped'); assert.equal(none.calls.slow.length, 0);
  // Something else in front with "notepad" in its title does not count: the process must be Notepad.
  const fake = desk({ front: () => ({ hwnd: 9, process: 'chrome', title: 'notepad - Google Search' }) });
  assert.equal((await H.run(fake.deps)).outcome, 'skipped'); assert.equal(fake.calls.slow.length, 0);
});

test('the person clicks away or presses a key mid-note: it stops at once and types nothing more', async () => {
  const d = desk({ stopAt: 12, stopWhy: 'person' });
  const r = await H.run(d.deps);
  assert.equal(r.outcome, 'interrupted'); assert.equal(r.why, 'person'); assert.equal(d.typed.length, 12);
  const after = d.calls.slow.findIndex((a) => a.text && d.typed.length === 12);
  assert.equal(d.calls.slow.slice(after + 1).filter((a) => a.text).length, 0, 'no typing after the stop');
  const esc = desk({ aborted: () => true });
  assert.equal((await H.run(esc.deps)).outcome, 'skipped');
});

test('the hello card: shown and spoken, the obvious button starts the tour, Not now leaves it owed', () => {
  const c = T.card(T.STEP.hello, { caps: { helloTyped: true } });
  assert.equal(T.STEP.hello, 0);
  assert.equal(c.kind, 'hello'); assert.equal(c.title, "Hey, I'm Nūs."); assert.equal(c.body, 'That was me. Wanna see what else I can do?');
  assert.equal(c.spoken, "Hey, I'm Nūs. That was me. Wanna see what else I can do?");
  assert.deepEqual(c.actions.map((a) => [a.id, a.label, !!a.primary]), [['tour-next', 'Show me', true], ['tour-later', 'Not now', false]]);
  assert.equal(c.skip, false);
  const none = T.card(T.STEP.hello, { caps: { helloTyped: false } });
  assert.doesNotMatch(none.body + none.spoken, /That was me/, 'never claims a note it did not type');
  assert.ok(T.cachedLines().includes(T.HELLO_LINE), 'the line is made ahead in the Knot\'s voice');
});

test('wiring: the helper checks before every character, and the run needs no key, no model, no Hands switch', () => {
  const ps = read('companion/src/reflex/hands.ps1');
  const op = ps.slice(ps.indexOf("'keys.slow' {"), ps.indexOf("'keys.copy' {"));
  assert.match(op, /foreach \(\$c in \$t\.ToCharArray\(\)\) \{\s*\n\s*if \(-not \[NusHands\]::IsWindow\(\$h\)\)/);
  assert.match(op, /GetForegroundWindow\(\) -ne \$h\) \{ return @\{ ok=\$false; stopped='focus'/);
  assert.match(op, /PersonActive\(\)\) \{ return @\{ ok=\$false; stopped='person'/);
  assert.doesNotMatch(op, /Activate|SetForegroundWindow|Clipboard/, 'never brings a window forward, never touches the clipboard');
  const idx = read('companion/index.js');
  const fn = idx.slice(idx.indexOf('async function tourHello('), idx.indexOf('function tourLater('));
  assert.match(fn, /probe\.request\('fg', \{\}, 1500\)/, 'the real foreground, our windows included');
  assert.doesNotMatch(fn, /createLLM|guideLlm|apiKeys|typesafe|settings\(\)\.hands|store\.getSettings\(\)\.hands/i);
  assert.doesNotMatch(fn, /ctrl\+s|ctrl\+w|0x53|0x57/i, 'never saves or closes');
  assert.match(idx, /if \(action === 'tour-later' && tour\.step === S\.hello\) \{ tourLater\(\); return; \}/);
  const main = read('src/main-companion.js');
  assert.match(main, /if \(firstRun && !SMOKE && process\.env\.NUS_HELLO !== '0'\) setTimeout\(\(\) => \{ try \{ companion\.helloFirstRun\(\);/);
  assert.ok(main.indexOf('companion.helloFirstRun()') > main.indexOf('publik.module.ensureSignedIn('), 'after the sign-in');
  // Bringing Notepad forward picks a window with a title: Windows 11 runs hidden Notepad processes.
  assert.match(ps, /Sort-Object \{ \[string\]::IsNullOrEmpty\(\[string\]\$_\.MainWindowTitle\) \} \| Select-Object -First 1/);
});

test('Fable ships with Nūs: bundled first, loaded during the sign-in, one shared engine, no first-run download', () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const { createVoice } = require('../src/voice');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-voice-'));
  const bundle = path.join(tmp, 'bundle'), folder = path.join(bundle, 'kokoro-multi-lang-v1_0');
  fs.mkdirSync(folder, { recursive: true });
  const v0 = createVoice({ userData: path.join(tmp, 'user'), settings: { get: () => ({}) }, bundled: [bundle] });
  assert.equal(v0.status().installed, false); assert.equal(v0.status().voice, 'system', 'no model anywhere: the Windows voice');
  fs.writeFileSync(path.join(folder, 'voices.bin'), 'x'); fs.writeFileSync(path.join(folder, 'model.onnx'), 'x');
  const v = createVoice({ userData: path.join(tmp, 'user'), settings: { get: () => ({}) }, bundled: [bundle] });
  assert.equal(v.status().installed, true); assert.equal(v.status().voice, 'fable', 'bundled: Fable from the first word, no choice needed');
  assert.equal(v.modelDir(), folder);
  const chose = createVoice({ userData: path.join(tmp, 'user'), settings: { get: () => ({ voice: 'system' }) }, bundled: [bundle] });
  assert.equal(chose.status().voice, 'system', 'a Windows voice chosen in Settings is kept');
  const main = read('src/main-companion.js');
  const at = main.indexOf('global.__nusVoice = createVoice(');
  assert.ok(at > 0 && at < main.indexOf('publik.module.ensureSignedIn('), 'made before the sign-in window');
  assert.match(main, /if \(st\.installed && st\.voice !== 'system'\) \{ const t0 = Date\.now\(\); global\.__nusVoice\.warm\(\)/, 'and loaded while the person signs in');
  const idx = read('companion/index.js');
  assert.match(idx, /voice = global\.__nusVoice \|\| createVoice\(/, 'the companion uses the same engine');
  assert.match(idx, /voice\.setOnState\(onState\);/);
  assert.doesNotMatch(idx + main, /voiceAutoEquip|voice_auto|__nusVoiceEarly/, 'no first-run download path left');
  const cfg = read('electron-builder.companion.config.js');
  assert.match(cfg, /from: 'vendor\/voice\/kokoro-multi-lang-v1_0', to: 'voice\/kokoro-multi-lang-v1_0'/, 'the installer carries it');
  assert.match(read('THIRD-PARTY.md'), /espeak-ng-data[\s\S]*GNU General Public License v3\.0/, 'the licences are noted');
  assert.doesNotMatch(read('companion/home/index.html'), /One download of about 350 MB/);
});
