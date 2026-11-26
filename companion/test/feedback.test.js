const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFeedback, tellText, FEEDBACK_URL } = require('../src/feedback');

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const DAY = 86400000;

// A feedback instance on a throwaway folder with a recording fetch; packaged
// by default so the default case is the one a real install sees.
function rig(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nus-feedback-'));
  const calls = [];
  const responder = opts.responder || (() => ({ status: 200 }));
  const fetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body), init }); const r = responder(calls.length); if (r instanceof Error) throw r; return r; };
  const clock = opts.clock || { t: Date.parse('2026-10-13T10:00:00Z') };
  const fb = createFeedback({ userData: dir, appVersion: '0.1.7', platform: 'win32', arch: 'x64', packaged: opts.packaged !== false, env: opts.env || {},
    installId: opts.installId || (() => '11111111-2222-4333-8444-555555555555'), fetch, now: () => clock.t });
  return { dir, calls, fb, clock, outbox: () => JSON.parse(fs.readFileSync(path.join(dir, 'feedback-outbox.json'), 'utf8')).items };
}

test('tellText finds words addressed to Pranav and nothing else', () => {
  assert.equal(tellText('Tell Pranav the voice is too slow'), 'the voice is too slow');
  assert.equal(tellText('tell pranav that it crashed when I opened Word'), 'it crashed when I opened Word');
  assert.equal(tellText('hey Nūs, can you tell Pranav: dark mode please'), 'dark mode please');
  assert.equal(tellText('let the founder know the Knot covers my button'), 'the Knot covers my button');
  assert.equal(tellText('Message Pranab I love it'), 'I love it');
  assert.equal(tellText('feedback: answers are too long'), 'answers are too long');
  assert.equal(tellText('send feedback to Pranav'), '');
  assert.equal(tellText('give some feedback to the founder: love the voice'), 'love the voice');
  assert.equal(tellText('tell Pranav'), '');
  assert.equal(tellText('give feedback on my essay'), null);
  assert.equal(tellText('send feedback'), null);
  assert.equal(tellText('text Pranav I am running late'), null);
  assert.equal(tellText('tell the developer console to clear'), null);
  assert.equal(tellText('tell Professor Lee I will be late'), null);
  assert.equal(tellText('what is the feedback loop in this circuit'), null);
  assert.equal(tellText('open my email'), null);
  assert.equal(tellText(''), null);
});

test('a note has the submit-feedback shape and goes only to that URL', async () => {
  const r = rig();
  const out = await r.fb.tell('the voice is too slow');
  assert.deepEqual(out, { delivered: true, waiting: 0 });
  assert.equal(r.calls.length, 1);
  const c = r.calls[0];
  assert.equal(c.url, FEEDBACK_URL);
  assert.equal(c.init.method, 'POST');
  assert.deepEqual(Object.keys(c.init.headers), ['Content-Type']);
  assert.equal(c.body.source, 'companion');
  assert.equal(c.body.kind, 'other');
  assert.equal(c.body.message, 'the voice is too slow');
  assert.equal(c.body.install_id, '11111111-2222-4333-8444-555555555555');
  assert.equal(c.body.website, '');
  assert.deepEqual(Object.keys(c.body.diagnostics).sort(), ['asks', 'collector', 'days']);
  assert.equal(c.body.diagnostics.collector, 'tell');
  assert.deepEqual(r.outbox(), []);
});

test('with stats off the note carries no install id', async () => {
  const r = rig({ installId: () => null });
  await r.fb.tell('hello');
  assert.equal(r.calls[0].body.install_id, null);
});

test('a 404 (function not deployed) or no network keeps the note, and the next flush sends it', async () => {
  let status = 404;
  const r = rig({ responder: () => (status === 0 ? new Error('offline') : { status }) });
  const first = await r.fb.tell('first note');
  assert.deepEqual(first, { delivered: false, waiting: 1 });
  status = 0;
  await r.fb.tell('second note');
  assert.equal(r.outbox().length, 2);
  assert.equal(r.outbox()[0].tries, 2);
  status = 200;
  const done = await r.fb.flush();
  assert.deepEqual(done, { sent: 2, waiting: 0 });
  assert.deepEqual(r.calls.slice(-2).map(c => c.body.message), ['first note', 'second note']);
});

test('a 400 drops the note for good; a 429 keeps it', async () => {
  let status = 429;
  const r = rig({ responder: () => ({ status }) });
  await r.fb.tell('kept');
  assert.equal(r.outbox().length, 1);
  status = 400;
  await r.fb.flush();
  assert.equal(r.outbox().length, 0);
});

test('a dev run never sends unless NUS_FEEDBACK=1, and NUS_FEEDBACK=0 stops a packaged one', async () => {
  const dev = rig({ packaged: false });
  await dev.fb.tell('dev note');
  assert.equal(dev.calls.length, 0);
  assert.equal(dev.outbox().length, 1);
  const opted = rig({ packaged: false, env: { NUS_FEEDBACK: '1' } });
  await opted.fb.tell('dev note');
  assert.equal(opted.calls.length, 1);
  const off = rig({ env: { NUS_FEEDBACK: '0' } });
  await off.fb.tell('note');
  assert.equal(off.calls.length, 0);
});

test('empty words send nothing', async () => {
  const r = rig();
  const out = await r.fb.tell('   ');
  assert.equal(out.empty, true);
  assert.equal(r.calls.length, 0);
});

test('reactions come after the 1st, 5th and 25th ask, one a day, and never after "Don\'t ask again"', () => {
  const r = rig();
  assert.equal(r.fb.due(), null);
  r.fb.noteAsk('voice');
  assert.equal(r.fb.due(), 'reaction');
  r.fb.shown('reaction');
  assert.equal(r.fb.due(), null);
  for (let i = 0; i < 4; i++) r.fb.noteAsk('text');
  assert.equal(r.fb.due(), null, 'already asked today');
  r.clock.t += 15 * 3600000; // 01:00 the next UTC day, still before the day-3 check-in
  assert.equal(r.fb.due(), 'reaction');
  r.fb.shown('reaction');
  r.clock.t += DAY;
  assert.equal(r.fb.due(), null, 'the 25th ask has not come');
  r.fb.never();
  for (let i = 0; i < 30; i++) r.fb.noteAsk('text');
  r.clock.t += 5 * DAY;
  assert.equal(r.fb.due(), null);
});

test('the day-3 check-in comes once, before a reaction', () => {
  const r = rig();
  r.fb.noteAsk('text');
  r.clock.t += 3 * DAY;
  assert.equal(r.fb.due(), 'checkin');
  r.fb.shown('checkin');
  r.clock.t += DAY;
  assert.equal(r.fb.due(), 'reaction');
  r.fb.shown('reaction');
  r.clock.t += 10 * DAY;
  assert.equal(r.fb.due(), null);
});

test('a reaction sends fixed words and the mode, never the ask', async () => {
  const r = rig();
  r.fb.noteAsk('voice');
  await r.fb.reaction('down', 'slow');
  const b = r.calls[0].body;
  assert.equal(b.message, 'Reaction: not useful: too slow (ask 1, voice)');
  assert.deepEqual(b.diagnostics, { collector: 'reaction', asks: 1, days: 0, rating: 'down', reason: 'slow', mode: 'voice' });
  await r.fb.reaction('up');
  assert.equal(r.calls[1].body.message, 'Reaction: useful (ask 1, voice)');
  await r.fb.reaction('down', 'made-up');
  assert.equal(r.calls[2].body.message, 'Reaction: not useful (ask 1, voice)');
  assert.equal(r.calls[2].body.diagnostics.reason, undefined);
});

test('the outbox keeps at most 50 notes and drops ones older than 30 days', async () => {
  const r = rig({ responder: () => ({ status: 404 }) });
  for (let i = 0; i < 55; i++) await r.fb.tell('n' + i);
  assert.equal(r.outbox().length, 50);
  assert.equal(r.outbox()[0].body.message, 'n5');
  r.clock.t += 31 * 86400000;
  await r.fb.flush();
  assert.equal(r.outbox().length, 0);
});

test('the Companion wires the collectors: tell, reactions, check-in, tray line, flush', () => {
  const index = read('companion/index.js');
  const host = read('src/main-companion.js');
  const renderer = read('companion/renderer/renderer.js');
  assert.match(host, /createFeedback\(/);
  assert.match(host, /^\s+feedback,\r?$/m);
  assert.match(index, /tellText\(/);
  assert.match(index, /fb-send/);
  assert.match(index, /fb-up/);
  assert.match(index, /fb-never/);
  assert.match(index, /Tell Pranav/);
  assert.match(renderer, /feedback/);
  // The bubble's own styles are untouched: no new CSS for these prompts.
  assert.doesNotMatch(read('companion/renderer/styles.css'), /fb-/);
});

test('the Home form sends its kind and a typed reply address, and drops a bad one', async () => {
  const r = rig();
  await r.fb.submit({ message: 'The island covers my tabs', kind: 'bug', email: 'student@school.edu', collector: 'home' });
  await r.fb.submit({ message: 'More voices', kind: 'idea', email: 'not an email', collector: 'home' });
  assert.equal(r.calls.length, 2);
  assert.equal(r.calls[0].body.kind, 'bug');
  assert.equal(r.calls[0].body.email, 'student@school.edu');
  assert.equal(r.calls[0].body.diagnostics.collector, 'home');
  assert.equal(r.calls[1].body.kind, 'idea');
  assert.equal('email' in r.calls[1].body, false);
});

test('Home, tray and the error bubble are wired to the feedback module', () => {
  const html = read('companion/home/index.html');
  assert.match(html, /data-view="feedback"/);
  assert.match(html, /id="feedback-form"/);
  assert.match(read('companion/home/preload.js'), /feedbackSend: p => invoke\('feedback:send', p\)/);
  const host = read('src/main-companion.js');
  assert.match(host, /handle\('home:feedback:send'/);
  assert.match(host, /showFeedback:/);
  const knot = read('companion/index.js');
  assert.match(knot, /Send feedback to Pranav\.\.\./);
  assert.match(knot, /id: 'fb-error', label: 'Tell Pranav'/);
});
