// The contact card (companion/src/contact.js): one ask for an email, after
// something worked. Pranav's ruling on it is pending (2026-11-11), so these
// tests pin what was built: when it may show, what leaves the computer, and
// that the address never rides with an install id or reaches anything else.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createContact, cleanEmail, WORDS, NOTE, COLLECTOR, LINK_INSTALL, WAIT_AFTER_WIN_MS, MAX_BUBBLES } = require('../src/contact');
const { createFeedback, FEEDBACK_URL } = require('../src/feedback');

const root = path.resolve(__dirname, '../..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');
const DAY = 24 * 3600 * 1000;

function rig(opts = {}) {
  const dir = opts.dir || fs.mkdtempSync(path.join(os.tmpdir(), 'nus-contact-'));
  const clock = { t: opts.t || new Date(2026, 10, 12, 10, 0, 0).getTime() };
  const posts = [];
  const net = { status: opts.status === undefined ? 200 : opts.status };
  const feedback = createFeedback({ userData: dir, appVersion: '0.1.19', platform: 'win32', arch: 'x64', packaged: true, env: {},
    installId: () => '11111111-2222-4333-8444-555555555555', now: () => clock.t,
    fetch: async (url, init) => { if (net.status === 0) throw new Error('offline'); posts.push({ url, body: JSON.parse(init.body) }); return { status: net.status }; } });
  const contact = createContact({ file: path.join(dir, 'companion', 'contact.json'), now: () => clock.t, feedback: opts.noPipe ? null : feedback });
  return { dir, clock, posts, net, contact, feedback, done: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('never before a first win, and not on top of it', () => {
  const r = rig();
  assert.equal(r.contact.due(), false, 'a new install: nothing');
  r.clock.t += 30 * DAY;
  assert.equal(r.contact.due(), false, 'a month in with no win: still nothing');
  r.contact.noteWin();
  assert.equal(r.contact.due(), false, 'right after the win: not yet');
  r.clock.t += WAIT_AFTER_WIN_MS - 1000;
  assert.equal(r.contact.due(), false);
  r.clock.t += 1000;
  assert.equal(r.contact.due(), true);
  assert.equal(r.contact.bubbleDue(), true);
  r.done();
});

test('the Knot asks twice at most, on different days; the answer ends it', () => {
  const r = rig();
  r.contact.noteWin();
  r.clock.t += WAIT_AFTER_WIN_MS;
  assert.equal(MAX_BUBBLES, 2);
  r.contact.bubbleShown();
  assert.equal(r.contact.bubbleDue(), false, 'not twice in a day');
  assert.equal(r.contact.due(), true, 'the dashboard card stays');
  r.clock.t += DAY;
  assert.equal(r.contact.bubbleDue(), true);
  r.contact.bubbleShown();
  r.clock.t += DAY;
  assert.equal(r.contact.bubbleDue(), false, 'two is the limit');
  assert.equal(r.contact.due(), true);
  r.contact.decline();
  assert.equal(r.contact.due(), false);
  assert.equal(r.contact.status().answer, 'declined');
  // "No thanks" hides it for good, across restarts and later wins.
  const again = rig({ dir: r.dir, t: r.clock.t + 90 * DAY });
  again.contact.noteWin();
  assert.equal(again.contact.due(), false);
  assert.equal(again.contact.bubbleDue(), false);
  r.done();
});

test('an address is checked the way the site and the server check it', () => {
  assert.equal(cleanEmail('  sam@school.edu '), 'sam@school.edu');
  for (const bad of ['', 'sam', 'sam@', 'sam@school', 'sam @school.edu', '@school.edu', 'a'.repeat(195) + '@x.com']) assert.equal(cleanEmail(bad), '', bad);
});

test('any normal address is accepted, and no email box asks for a school one', () => {
  for (const ok of ['sam@gmail.com', 'sam.lee+nus@outlook.com', 'sam@proton.me', 'sam@mail.example.co.uk', 'sam@school.edu']) assert.equal(cleanEmail(ok), ok, ok);
  // Every word the update card and the Knot show, and every email box the dashboard draws.
  for (const [key, text] of Object.entries(WORDS)) assert.doesNotMatch(String(text), /\.edu\b|school|student|universit|college/i, key);
  const home = read('companion/home/index.html');
  const boxes = home.match(/<input[^>]*type="email"[^>]*>/g) || [];
  assert.ok(boxes.length >= 2, 'the feedback box and the update box are both there');
  for (const box of boxes) assert.doesNotMatch(box, /\.edu\b|school|student|universit|college/i, box);
  assert.match(home, /id="feedback-email"[^>]*placeholder="Your email"/);
});

test('a bad address saves nothing and the ask stays', async () => {
  const r = rig();
  r.contact.noteWin(); r.clock.t += WAIT_AFTER_WIN_MS;
  const out = await r.contact.give('not an email');
  assert.deepEqual(out, { ok: false, reason: 'bad_email' });
  assert.equal(r.posts.length, 0);
  assert.equal(r.contact.due(), true);
  r.done();
});

test('what leaves: the fixed note and the address, to the feedback notes, with no install id', async () => {
  const r = rig();
  r.contact.noteWin(); r.clock.t += WAIT_AFTER_WIN_MS;
  r.feedback.noteAsk('voice'); r.feedback.noteAsk('text');
  const out = await r.contact.give('sam@school.edu');
  assert.deepEqual(out, { ok: true, delivered: true });
  assert.equal(r.posts.length, 1);
  assert.equal(r.posts[0].url, FEEDBACK_URL, 'the same function the site\'s Mac waitlist posts to');
  const body = r.posts[0].body;
  assert.equal(LINK_INSTALL, false, 'the built default: the address travels alone');
  assert.deepEqual(body, { source: 'companion', kind: 'other', message: NOTE, install_id: null, app_version: '0.1.19', platform: 'win32', arch: 'x64',
    diagnostics: { collector: COLLECTOR }, website: '', email: 'sam@school.edu' });
  assert.doesNotMatch(JSON.stringify(body), /11111111-2222/, 'no install id anywhere in it');
  assert.equal(r.contact.due(), false);
  assert.equal(r.contact.status().answer, 'saved');
  // The address is not kept on this computer once it is in the outbox and gone.
  assert.doesNotMatch(fs.readFileSync(path.join(r.dir, 'companion', 'contact.json'), 'utf8'), /sam@school/);
  r.done();
});

test('every other note still carries what it carried before', async () => {
  const r = rig();
  await r.feedback.submit({ message: 'The pill is too small', collector: 'home', kind: 'idea' });
  assert.equal(r.posts[0].body.install_id, '11111111-2222-4333-8444-555555555555');
  assert.deepEqual(Object.keys(r.posts[0].body.diagnostics).sort(), ['asks', 'collector', 'days']);
  r.done();
});

test('offline: the address waits in the outbox and goes later; the ask is answered', async () => {
  const r = rig({ status: 0 });
  r.contact.noteWin(); r.clock.t += WAIT_AFTER_WIN_MS;
  const out = await r.contact.give('sam@school.edu');
  assert.deepEqual(out, { ok: true, delivered: false });
  assert.equal(r.contact.due(), false);
  r.net.status = 200;
  const f = await r.feedback.flush();
  assert.equal(f.sent, 1);
  assert.equal(r.posts[0].body.email, 'sam@school.edu');
  r.done();
});

test('no feedback pipe: nothing is saved and nothing is claimed', async () => {
  const r = rig({ noPipe: true });
  r.contact.noteWin(); r.clock.t += WAIT_AFTER_WIN_MS;
  assert.deepEqual(await r.contact.give('sam@school.edu'), { ok: false, reason: 'no_pipe' });
  assert.equal(r.contact.due(), true);
  r.done();
});

test('the words: plain, no account, no em dash, and they say what it is for', () => {
  for (const line of Object.values(WORDS)) assert.doesNotMatch(line, /[—–]/, line);
  assert.match(WORDS.bubble, /when something new ships/);
  assert.match(WORDS.bubble, /Nothing else, and no account/);
  assert.match(WORDS.cardBody, /Nothing else, and no account/);
  assert.match(WORDS.cardBody, /Ask any time and it is deleted/);
  assert.match(WORDS.cardBody, LINK_INSTALL ? /install id/ : /kept apart from your usage stats/);
  assert.equal(WORDS.no, 'No thanks');
  assert.doesNotMatch(Object.values(WORDS).join(' '), /password|sign in|sign up|publik/i);
});

test('wiring: after a win, inside the pop-up budget, never in the tour, never to a model', () => {
  const core = read('companion/index.js');
  assert.match(core, /try \{ getContact\(\)\.noteWin\(\); \} catch/, 'a win starts the clock');
  // The Knot's ask goes through the shared budget (rtShow), after the person's own things.
  const quiet = core.slice(core.indexOf('function rtTryQuietMoment()'), core.indexOf('// After the tour: the person\'s own "this week" answer'));
  assert.ok(quiet.indexOf('rtTryMorning()') < quiet.indexOf('rtTryContact()'), 'the morning line comes first');
  assert.match(core, /rtShow\('contact_card', W\.kicker, W\.bubble, \[\{ id: 'rt-contact-yes', label: W\.yes, primary: true \}, \{ id: 'rt-contact-no', label: W\.no \}\]\)/);
  const { EXEMPT } = require('../src/retention');
  assert.ok(!EXEMPT.has('contact_card'), 'it counts against one pop-up a day, three a week');
  assert.match(core, /const due = !!\(s\.due && hooks\.feedback && !tour\)/, 'never while the tour is on screen');
  // The typed address stops at contactGive, before anything that could log it or ask a model.
  const ask = core.slice(core.indexOf("companionIpc.on('companion:guide:ask'"));
  const at = ask.indexOf("if (p.contact === true) { contactGive(");
  assert.ok(at > 0 && at < ask.indexOf('tellIntercept(p.text'), 'before a note to Pranav is read from it');
  const typed = ask.indexOf('if (p && p.text && p.text.trim()) {');
  assert.ok(typed > 0 && at > typed && at - typed < 200, 'the first thing done with typed text');
  assert.match(ask.slice(at, at + 120), /contactGive\(String\(p\.text\)\.slice\(0, 200\), 'knot'\)\.catch\(\(\) => \{\}\); return; \}/, 'and it stops there');
  const give = core.slice(core.indexOf('async function contactGive('), core.indexOf('function contactDecline()'));
  assert.doesNotMatch(give, /routeLog|console\.log/, 'the address is never logged');
  // The renderer sends it as an address, not as an ask.
  const renderer = read('companion/renderer/renderer.js');
  assert.match(renderer, /if \(address\) \{ closeQuickAsk\(\); if \(text && nus\.guideAsk\) nus\.guideAsk\(\{ text, source: 'typed', contact: true \}\); return; \}/);
  // The dashboard card and its three calls.
  const main = read('src/main-companion.js');
  for (const ch of ["'home:contact:status'", "'home:contact:give'", "'home:contact:decline'"]) assert.ok(main.includes(ch), ch);
  const preload = read('companion/home/preload.js');
  assert.match(preload, /contactStatus: \(\) => invoke\('contact:status'\), contactGive: email => invoke\('contact:give', email\), contactDecline: \(\) => invoke\('contact:decline'\)/);
  const html = read('companion/home/index.html');
  assert.match(html, /<section id="contact-card" class="glass card" aria-label="News from Nūs" hidden>/);
  assert.match(html, /<input id="contact-email" type="email" maxlength="200"/);
  assert.equal((html.match(/id="contact-/g) || []).length, 8, 'one field, two buttons, the words, a note');
});

test('nothing about the address touches publik or the anonymous stats', () => {
  const src = read('companion/src/contact.js');
  assert.doesNotMatch(src, /require\(['"][^'"]*(publik|stats)/);
  const stats = read('companion/src/stats.js');
  assert.doesNotMatch(stats, /contact\.json|cleanEmail|feedback/);
});

test('the dashboard keeps the thank-you up: the "no longer due" push cannot hide the card mid-save', () => {
  const home = read('companion/home/home.js');
  const submit = home.slice(home.indexOf("$('#contact-form').onsubmit"), home.indexOf("$('#contact-no').onclick"));
  assert.ok(submit.indexOf('contactHold = true') < submit.indexOf('api.contactGive('), 'held before the save is sent');
  assert.match(home, /function paintContact\(c\) \{\n    if \(!c \|\| !c\.words\) return;\n    if \(contactHold\) return;/);
  assert.match(submit, /if \(!r \|\| !r\.ok\) contactHold = false;/, 'a failed save lets the card repaint');
});

test('after a save the form really goes away (its flex style must not beat hidden)', () => {
  assert.match(read('companion/home/home.css'), /#contact-form\[hidden\]\{display:none\}/);
});
