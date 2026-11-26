const test = require('node:test');
const assert = require('node:assert/strict');
const { Assignment, classifyAsk, friendlyError, MIN_GAP_MS } = require('../src/guide/assignment');

const N = 48 * 27;
const cells = (v, patch) => { const c = new Uint8Array(N).fill(v); if (patch) c.fill(patch.v, 0, patch.n); return c; };
const CHROME = 'Canvas Dashboard Courses Calendar Inbox Homework 4 Submit Save ';
const P1 = CHROME + 'Question 3 A block of mass 2 kg slides down a frictionless incline of angle 30 degrees. Find the acceleration of the block along the incline.';
const P1_SCROLLED = CHROME + 'frictionless incline of angle 30 degrees. Find the acceleration of the block along the incline. Enter your answer. Attempts remaining 3';
const P2 = CHROME + 'Question 4 A capacitor of 5 microfarads is charged through a 200 ohm resistor from a 12 volt battery. How long until it reaches half of its final voltage?';
const reply = (problem, extra) => JSON.stringify(Object.assign({ found: true, same: false, problem, steps: [{ title: 'Set it up', body: 'Write what is known.' }, { title: 'Work it', body: 'Do the algebra.' }, { title: 'Finish', body: 'State the result.' }], answer: '42', check: 'Substituted back.', confidence: 0.9 }, extra || {}));

function rig(over) {
  const w = { sent: [], logs: [], records: [], solves: [], ocrs: 0, now: 100000, fg: { process: 'chrome', title: 'HW 4' }, frame: cells(240), text: P1, reply: reply('Question 3: block on an incline'), idle: true };
  const a = new Assignment(Object.assign({
    foreground: async () => w.fg,
    frame: async () => ({ cells: w.frame }),
    capture: async () => ({ dataUrl: 'data:image/jpeg;base64,AA', jpeg: Buffer.from('x') }),
    ocr: async () => { w.ocrs++; if (w.text instanceof Error) throw w.text; return w.text; },
    solve: async (req) => { w.solves.push(req); if (w.reply instanceof Error) throw w.reply; return { text: w.reply, provider: 'test' }; },
    cursor: () => ({ x: 0.5, y: 0.5 }),
    idle: () => w.idle,
    send: (channel, payload) => w.sent.push({ channel, payload }),
    record: (rec) => w.records.push(rec),
    now: () => w.now,
    log: (m) => w.logs.push(m),
  }, over || {}));
  w.bubbles = () => w.sent.filter((s) => s.channel === 'guide:bubble').map((s) => s.payload);
  w.last = () => w.bubbles()[w.bubbles().length - 1];
  // The clock moves a real tick's worth each time, so the look gap clears.
  w.tick = async () => { w.now += 700; await a.tick(); };
  // Two ticks on the same frame = it has settled (the first may look early).
  w.settle = async (frame, text) => { w.frame = frame; if (text !== undefined) w.text = text; await w.tick(); await w.tick(); };
  return { a, w };
}

test('asks are sorted: mode words, pointing, solving, and everything else left alone', () => {
  assert.equal(classifyAsk('assignment mode', false), 'on');
  assert.equal(classifyAsk('can you help me with my homework', false), 'on');
  assert.equal(classifyAsk('stop assignment mode', true), 'off');
  assert.equal(classifyAsk('I am done with homework', true), 'off');
  assert.equal(classifyAsk('where is the submit button', true), 'point');
  assert.equal(classifyAsk('how do I turn on word wrap', true), 'point');
  assert.equal(classifyAsk('why did you divide by two', true), 'solve');
  assert.equal(classifyAsk('how do I find the derivative here', true), 'solve');
  assert.equal(classifyAsk('walk me through this problem', false), 'solve');
  assert.equal(classifyAsk('what is the answer to question 5', false), 'solve');
  assert.equal(classifyAsk('how do I turn on word wrap', false), null);
  assert.equal(classifyAsk('open spotify', false), null);
});

test('turning it on reads the problem in front and shows step 1 with Next', async () => {
  const { a, w } = rig();
  await a.start('typed');
  assert.equal(a.isOn(), true);
  assert.equal(w.solves.length, 1);
  assert.match(w.solves[0].text, /did not ask anything/);
  const b = w.last();
  assert.equal(b.task, 'solve');
  assert.match(b.kicker, /^step 1 of 3 · Set it up$/);
  assert.equal(b.text, 'Write what is known.');
  assert.match(b.hint, /Question 3/);
  assert.deepEqual(b.actions.map((x) => x.id), ['solve-next']);
  assert.equal(w.records.length, 1);
  assert.equal(w.records[0].reply.answer, '42');
});

test('Back, Next and Done walk the steps; the last one carries the answer and the check', async () => {
  const { a, w } = rig();
  await a.start('typed');
  a.action('solve-next');
  assert.deepEqual(w.last().actions.map((x) => x.id), ['solve-back', 'solve-next']);
  a.action('solve-next');
  assert.match(w.last().text, /State the result\.\n\nAnswer: 42$/);
  assert.match(w.last().hint, /Checked: Substituted back\./);
  assert.deepEqual(w.last().actions.map((x) => x.id), ['solve-back', 'solve-done']);
  a.action('solve-back');
  assert.match(w.last().kicker, /^step 2 of 3/);
  assert.equal(a.step(1), true);
  assert.equal(a.step(1), true, 'next on the last step closes it');
  assert.equal(a.showing(), false);
  assert.equal(w.sent[w.sent.length - 1].channel, 'guide:done');
  assert.equal(a.isOn(), true, 'closing a walkthrough does not leave the mode');
});

test('a low-confidence answer says so', async () => {
  const { a, w } = rig();
  w.reply = reply('Question 3', { confidence: 0.4 });
  await a.start('typed');
  a.action('solve-next'); a.action('solve-next');
  assert.match(w.last().hint, /not fully sure/);
});

test('the Knot\'s own bubble, and a screen still moving, never trigger a look', async () => {
  const { a, w } = rig();
  await a.start('typed');
  w.now += MIN_GAP_MS + 1;
  await w.settle(cells(240));                                  // baseline
  await w.settle(cells(240, { v: 20, n: Math.floor(N * 0.025) }));   // bubble-sized
  assert.equal(w.ocrs, 1, 'only the read at start');
  w.frame = cells(100); await w.tick();                         // moved, not settled yet: an early look, no call
  w.frame = cells(140); await w.tick();
  assert.equal(w.solves.length, 1);
  assert.ok(!w.logs.some((l) => /asking the model/.test(l)));
});

test('a scroll inside the problem costs an OCR and no model call', async () => {
  const { a, w } = rig();
  await a.start('typed');
  w.now += MIN_GAP_MS + 1;
  await w.settle(cells(240));
  await w.settle(cells(120), P1_SCROLLED);
  assert.ok(w.ocrs >= 2 && w.ocrs <= 3, 'an early look and a settled one, ocrs = ' + w.ocrs);
  assert.equal(w.solves.length, 1);
  assert.ok(w.logs.some((l) => /same words/.test(l)));
});

test('a new problem is noticed, solved once, and shown from step 1', async () => {
  const { a, w } = rig();
  await a.start('typed');
  a.action('solve-next');
  w.now += MIN_GAP_MS + 1;
  await w.settle(cells(240));
  w.reply = reply('Question 4: charging a capacitor');
  await w.settle(cells(120), P2);
  assert.equal(w.solves.length, 2);
  assert.match(w.solves[1].text, /Previous problem \(the one already walked through\): Question 3/);
  assert.match(w.last().kicker, /^step 1 of 3/);
  assert.match(w.last().hint, /Question 4/);
  assert.ok(w.sent.some((s) => s.channel === 'guide:hint' && /New problem/.test(s.payload.text)));
  // Still there two ticks later: nothing more is spent.
  await a.tick(); await a.tick();
  assert.equal(w.solves.length, 2);
});

test('when the model says it is the same problem, the walkthrough stays as it was', async () => {
  const { a, w } = rig();
  await a.start('typed');
  a.action('solve-next');
  const shown = w.bubbles().length;
  w.now += MIN_GAP_MS + 1;
  await w.settle(cells(240));
  w.reply = JSON.stringify({ found: true, same: true, problem: 'Question 3', steps: [] });
  await w.settle(cells(120), P2);
  assert.equal(w.solves.length, 2);
  assert.equal(w.bubbles().length, shown, 'no new bubble');
  assert.equal(a.status().problem, 'Question 3: block on an incline');
});

test('the watcher waits while the guide owns the Knot, and looks are at least a gap apart', async () => {
  const { a, w } = rig();
  await a.start('typed');
  await w.settle(cells(240));
  w.idle = false;
  await w.settle(cells(120), P2);
  assert.equal(w.solves.length, 1, 'a guide session owns the Knot');
  assert.equal(w.ocrs, 1, 'not even a look');
  w.idle = true;
  w.frame = cells(120);
  await a.tick(); await a.tick(); await a.tick();     // the clock does not move: one look at most
  assert.ok(w.ocrs <= 2, 'looks at least ' + MIN_GAP_MS + ' ms apart, ocrs = ' + w.ocrs);
  await w.settle(cells(120), P2);
  assert.equal(w.solves.length, 2);
});

test('switching apps is a look: the same page again is free, a new problem elsewhere is solved', async () => {
  const { a, w } = rig();
  await a.start('typed');
  await w.settle(cells(240));
  w.now += MIN_GAP_MS + 1;
  w.fg = { process: 'discord', title: 'chat' };
  w.reply = JSON.stringify({ found: false, problem: 'a chat', steps: [] });
  await w.settle(cells(30), CHROME + 'general random memes voice lobby Pranav: yo');
  assert.equal(w.solves.length, 2, 'a chat with new words gets one look from the model');
  assert.equal(a.status().problem, 'Question 3: block on an incline', 'and the walkthrough is untouched');
  w.now += MIN_GAP_MS + 1;
  w.fg = { process: 'chrome', title: 'HW 4' };
  await w.settle(cells(240), P1);
  const calls = w.solves.length;
  w.now += MIN_GAP_MS + 1;
  w.fg = { process: 'acrobat', title: 'hw4.pdf' };
  w.reply = reply('Question 4: charging a capacitor');
  await w.settle(cells(90), P2);
  assert.equal(w.solves.length, calls + 1);
  assert.equal(a.status().problem, 'Question 4: charging a capacitor');
  assert.equal(a.status().app, 'acrobat');
});

test('Jev stops a call on a confident same or nothing, and lets everything else through', async () => {
  let verdict = null;
  const { a, w } = rig({ judge: async () => verdict });
  await a.start('typed');
  await w.settle(cells(240));
  verdict = { verdict: 'same', choice: 'same', confidence: 0.9, hasProblem: 0.9, ms: 200 };
  await w.settle(cells(120), P2);
  assert.equal(w.solves.length, 1, 'jev said same');
  verdict = { verdict: 'none', choice: 'none', confidence: 0.9, hasProblem: 0.1, ms: 200 };
  await w.settle(cells(60), P2 + ' extra words here');
  assert.equal(w.solves.length, 1, 'jev said nothing to solve');
  verdict = { verdict: 'unsure', choice: 'same', confidence: 0.5, hasProblem: null, ms: 200 };
  await w.settle(cells(200), P2 + ' more new words again now');
  assert.equal(w.solves.length, 2, 'unsure goes to the model once the screen holds still');
  await w.settle(cells(200));   // a solve resets the baseline; this frame becomes it
  verdict = null;
  await w.settle(cells(20), P1 + ' yet another set of words');
  assert.equal(w.solves.length, 3, 'no opinion (null) goes to the model');
  assert.ok(w.logs.some((l) => /jev 200ms: same 0\.90/.test(l)));
});

test('Jev saying "different" on a screen still moving is enough: the model starts at once', async () => {
  const { a, w } = rig({ judge: async () => ({ verdict: 'different', choice: 'different', confidence: 0.99, hasProblem: 0.98, ms: 150 }) });
  await a.start('typed');
  await w.settle(cells(240));
  w.reply = reply('Question 4: charging a capacitor');
  w.frame = cells(90); w.text = P2;
  await w.tick();                                   // first frame of the change, nothing settled yet
  assert.equal(w.solves.length, 2, 'one early look, one call');
  assert.ok(w.logs.some((l) => /still moving/.test(l)));
  await w.tick(); await w.tick();
  assert.equal(w.solves.length, 2, 'the settled looks do not call again for the same words');
});

test('OCR failing falls open to the model', async () => {
  const { a, w } = rig();
  await a.start('typed');
  w.now += MIN_GAP_MS + 1;
  await w.settle(cells(240));
  w.reply = reply('Question 4');
  await w.settle(cells(120), new Error('no OCR language installed'));
  assert.equal(w.solves.length, 2);
});

test('a question gets a call with the walkthrough as context, and wins over a stale look', async () => {
  const { a, w } = rig();
  await a.start('typed');
  w.reply = reply('Question 3: block on an incline', { steps: [{ title: 'Why sine', body: 'Gravity along the slope is g sin(theta).' }] });
  await a.ask('why is it sine and not cosine', 'typed');
  assert.match(w.solves[1].text, /Its walkthrough so far:/);
  assert.match(w.solves[1].text, /The student says: why is it sine/);
  assert.match(w.last().kicker, /^step 1 of 1 · Why sine$/);
  assert.deepEqual(w.last().actions.map((x) => x.id), ['solve-done']);
});

test('a slow look that a question overtook is dropped', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { a, w } = rig();
  await a.start('typed');
  const slow = w.reply;
  let calls = 0;
  a.d.solve = async () => { calls++; if (calls === 1) { await gate; return { text: reply('STALE') }; } return { text: reply('FRESH') }; };
  const looking = a.solveNow({ auto: true });
  await a.ask('walk me through this one', 'typed');
  release();
  await looking;
  assert.equal(a.status().problem, 'FRESH');
  assert.ok(w.logs.some((l) => /newer ask took over/.test(l)));
  void slow;
});

test('failures read like something a person can act on', async () => {
  assert.match(friendlyError(new Error('cli_not_logged_in: Please run /login')), /signed out[\s\S]*free Gemini key[\s\S]*Settings, Keys/);
  assert.match(friendlyError(new Error('cli_failed: Failed to authenticate: OAuth session expired and could not be refreshed')), /signed out/);
  assert.match(friendlyError(new Error('429 quota')), /out of quota/);
  const { a, w } = rig();
  w.reply = new Error('cli_not_logged_in');
  await a.start('typed');
  assert.match(w.last().text, /Claude Code is signed out/);
  w.reply = JSON.stringify({ found: false, problem: 'a video', steps: [] });
  await a.ask('solve this', 'typed');
  assert.match(w.last().text, /do not see a problem/);
  w.reply = 'Could not view the screenshot.';
  await a.ask('solve this', 'typed');
  assert.match(w.last().text, /could not work this one out/);
});

test('turning it off clears the screen and stops the watcher', async () => {
  const { a, w } = rig();
  await a.start('typed');
  a.stop();
  assert.equal(a.isOn(), false);
  assert.equal(a.showing(), false);
  assert.ok(w.sent.some((s) => s.channel === 'guide:done'));
  const before = w.ocrs;
  w.now += MIN_GAP_MS + 1;
  await w.settle(cells(10), P2);
  assert.equal(w.ocrs, before);
});

test('it follows the person from app to app, and a problem found anywhere is solved', async () => {
  const { a, w } = rig();
  w.fg = { process: 'claude', title: 'Claude' };
  await a.start('typed', { solve: false });
  await w.settle(cells(240));
  w.fg = { process: 'chrome', title: 'HW 4' };
  await w.settle(cells(120), P1);
  assert.ok(w.logs.some((l) => /following chrome/.test(l)));
  assert.equal(w.solves.length, 1, 'found in the browser it moved to');
  assert.equal(a.status().app, 'chrome');
});

test('turning it on is said out loud and shown, for the recording', async () => {
  const { a, w } = rig();
  await a.start('typed', { solve: false });
  const b = w.bubbles()[0];
  assert.equal(b.text, 'Assignment mode on.');
  assert.equal(b.speak, 'Assignment mode on.');
  assert.equal(b.kicker, 'assignment mode');
  a.stop();
  const off = w.sent.find((s) => s.channel === 'guide:hint' && /off/.test(s.payload.text));
  assert.equal(off.payload.speak, 'Assignment mode off.');
});

test('a click or a key is a poke: two looks, and a click that changed nothing costs one thumbnail', async () => {
  const timers = [];
  const { a, w } = rig({ later: (ms, fn) => { const t = { ms, fn, dead: false }; timers.push(t); return t; }, cancel: (t) => { t.dead = true; } });
  const fire = async () => { const due = timers.splice(0).filter((t) => !t.dead); for (const t of due) { t.fn(); await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); } };
  await a.start('typed');
  a.poke('click');
  assert.deepEqual(timers.map((t) => t.ms), [350, 1500]);
  a.poke('click');                                   // a burst: the first pair is cancelled
  assert.equal(timers.filter((t) => !t.dead).length, 2);
  await fire();                                      // same frame as ever: first look sets the reference, second sees nothing moved
  const ocrsQuiet = w.ocrs;
  a.poke('click');
  await fire();
  assert.equal(w.ocrs, ocrsQuiet, 'nothing moved: no capture, no OCR');
  assert.equal(w.solves.length, 1);
  // The click that loads the next problem.
  w.reply = reply('Question 4: charging a capacitor');
  w.frame = cells(240, { v: 60, n: 40 });            // one line of formula changed
  w.text = P2;
  a.poke('click');
  await fire();
  assert.equal(w.solves.length, 2);
  assert.equal(a.status().problem, 'Question 4: charging a capacitor');
  a.stop();
  a.poke('click');
  assert.equal(timers.filter((t) => !t.dead).length, 0, 'off means off');
});

test('the pulse asks only which window is in front, and a new title is a poke', async () => {
  const timers = [];
  const { a, w } = rig({ later: (ms, fn) => { timers.push({ ms, fn }); return timers.length; }, cancel: () => {} });
  await a.start('typed');
  const frames = w.ocrs;
  await a.pulse();
  assert.equal(timers.length, 0, 'same window, nothing to do');
  w.fg = { process: 'chrome', title: 'HW 4: Problem 6' };
  await a.pulse();
  assert.equal(timers.length, 2);
  assert.equal(w.ocrs, frames, 'the pulse itself never captures');
  assert.ok(w.logs.some((l) => /following chrome "HW 4: Problem 6"/.test(l)));
});

test('started quietly (NUS_ASSIGNMENT=1) it waits for the screen to change', async () => {
  const { a, w } = rig();
  await a.start('typed', { solve: false });
  assert.equal(w.solves.length, 0);
  await w.settle(cells(240));
  await w.settle(cells(120), P1);
  assert.equal(w.solves.length, 1);
  assert.match(w.last().kicker, /^step 1 of 3/);
});
