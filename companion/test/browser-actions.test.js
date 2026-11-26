'use strict';
// The browser actions, as Hands runs them: a fake controller stands in for Zen,
// so this checks the wiring (options, reports, refusals) rather than the
// protocol, which browser-zen.test.js already pins.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createActions } = require('../src/hands/actions');
const { preview } = require('../src/hands/consent');

function rig(browser) {
  const opened = [];
  const actions = createActions({
    probe: null, hands: { async request() { return { ok: true }; } },
    shell: { async openExternal(u) { opened.push(u); } },
    pointAt: null, settleThread: 0, apps: () => [], searchFiles: async () => [],
    openPath: async () => '', sleep: async () => {}, browser,
  });
  return { actions, opened };
}

test('with no controller, every browser action says how to turn it on instead of failing obscurely', async () => {
  const { actions } = rig(null);
  for (const name of ['browser_read', 'browser_click', 'browser_type', 'browser_press', 'browser_open']) {
    const r = await actions.run(name, { selector: '#a', text: 'x', key: 'Enter', url: 'https://example.com' }, {});
    assert.equal(r.ok, false, name);
    assert.equal(r.no_browser, true, name + ' is flagged so the caller can stay quiet about it');
    assert.match(r.report, /Zen is not set up for remote control/, name);
    assert.match(r.report, /quit Zen and open it again/, name + ' names the fix');
  }
});

test('reading the page returns the text in the report, with what was cut said plainly', async () => {
  const page = { title: 'Lab 3 - Canvas', url: 'https://canvas.example/x', text: 'Submit by Friday.', length: 18, truncated: false };
  const { actions } = rig({ async read() { return page; } });
  const r = await actions.run('browser_read', {}, {});
  assert.equal(r.ok, true);
  assert.match(r.report, /read "Lab 3 - Canvas"/);
  assert.match(r.report, /18 characters/);
  assert.match(r.report, /Submit by Friday\./);
  assert.doesNotMatch(r.report, /cut to the first/);
});

test('a cut page says so in the report, because the model must not assume it saw everything', async () => {
  const { actions } = rig({ async read() { return { title: 'Long', url: 'https://x.y', text: 'a'.repeat(500), length: 9000, truncated: true }; } });
  const r = await actions.run('browser_read', {}, {});
  assert.match(r.report, /9000 characters, cut to the first 500/);
});

test('a click reports the label the page gave, which is what the card showed', async () => {
  const { actions } = rig({ async click(sel) { return { label: 'Submit assignment', selector: sel }; } });
  const r = await actions.run('browser_click', { selector: '#submit' }, {});
  assert.equal(r.ok, true);
  assert.match(r.report, /clicked "Submit assignment"/);
});

test('a click with no selector is refused before it reaches the browser', async () => {
  let called = 0;
  const { actions } = rig({ async click() { called++; return {}; } });
  const r = await actions.run('browser_click', {}, {});
  assert.equal(r.ok, false);
  assert.equal(called, 0, 'nothing was asked of the page');
  assert.match(r.report, /no selector/);
});

test('typing passes submit through, and the report says when the form was sent', async () => {
  const seen = [];
  const { actions } = rig({ async type(sel, text, opts) { seen.push([sel, text, opts]); } });
  const plain = await actions.run('browser_type', { selector: '#body', text: 'hello' }, {});
  const sent = await actions.run('browser_type', { selector: '#body', text: 'hello', submit: true }, {});
  assert.equal(seen[0][2].submit, false);
  assert.equal(seen[1][2].submit, true);
  assert.match(plain.report, /typed 5 characters into #body/);
  assert.doesNotMatch(plain.report, /submitted/);
  assert.match(sent.report, /submitted the form/);
});

test('an empty field or an empty key is refused without a page round trip', async () => {
  let called = 0;
  const { actions } = rig({ async type() { called++; }, async press() { called++; } });
  assert.equal((await actions.run('browser_type', { selector: '#a' }, {})).ok, false);
  assert.equal((await actions.run('browser_type', { text: 'x' }, {})).ok, false);
  assert.equal((await actions.run('browser_press', {}, {})).ok, false);
  assert.equal(called, 0);
});

test('browser_open normalises an address, refuses a non-address, and respects the focus guard', async () => {
  const nav = [];
  const { actions } = rig({ async navigate(u) { nav.push(u); } });
  const ok = await actions.run('browser_open', { url: 'canvas.example/lab' }, {});
  assert.equal(ok.ok, true);
  assert.deepEqual(nav, ['https://canvas.example/lab']);
  assert.match(ok.report, /opened https:\/\/canvas\.example\/lab in Zen/);

  const bad = await actions.run('browser_open', { url: 'not a web address' }, {});
  assert.equal(bad.ok, false);
  assert.equal(nav.length, 1, 'nothing was navigated');

  // The focus guard still wins: a site the person asked to be kept off is refused.
  const guarded = createActions({
    probe: null, hands: { async request() { return { ok: true }; } }, shell: {}, pointAt: null,
    settleThread: 0, apps: () => [], searchFiles: async () => [], openPath: async () => '',
    sleep: async () => {}, browser: { async navigate(u) { nav.push(u); } },
    refuseSite: (u) => (/reels/.test(u) ? 'You asked to stay off reels.' : ''),
  });
  const g = await guarded.run('browser_open', { url: 'https://youtube.com/reels' }, {});
  assert.equal(g.ok, false);
  assert.equal(g.guarded, true);
  assert.match(g.report, /You asked to stay off reels/);
  assert.equal(nav.length, 1);
});

test('a browser that is not listening is reported as such, with the reason in the words the user sees', async () => {
  const { BidiError } = require('../src/browser/zen');
  const { actions } = rig({ async read() { throw new BidiError('no', { kind: 'offline' }); } });
  const r = await actions.run('browser_read', {}, {});
  assert.equal(r.ok, false);
  assert.equal(r.no_browser, true);
  assert.match(r.report, /reopen it with remote debugging/);
});

test('a page error keeps the page\'s own reason, and is not mistaken for a missing browser', async () => {
  const { BidiError } = require('../src/browser/zen');
  const { actions } = rig({ async click() { throw new BidiError('Nothing on the page matches #x.', { kind: 'page' }); } });
  const r = await actions.run('browser_click', { selector: '#x' }, {});
  assert.equal(r.ok, false);
  assert.equal(r.no_browser, undefined, 'the browser is there; the page just did not have it');
  assert.match(r.report, /Nothing on the page matches #x/);
});

test('the browser actions are offered only when there is a browser to drive', () => {
  const off = rig(null).actions;
  for (const n of ['browser_read', 'browser_click', 'browser_type', 'browser_press', 'browser_open']) {
    assert.ok(!off.names.includes(n), n + ' is not offered with nothing to drive it');
  }
  // Every other action is still there: the switch removes five names, not the app.
  assert.ok(off.names.includes('click') && off.names.includes('type') && off.names.includes('open_url'));

  const held = { get current() { return { read: async () => ({}) }; } };
  const on = rig(held).actions;
  for (const n of ['browser_read', 'browser_click', 'browser_type', 'browser_press', 'browser_open']) {
    assert.ok(on.names.includes(n), n + ' appears once the switch is on');
  }
});

test('a holder whose switch is flipped later changes what is offered, without rebuilding', () => {
  let on = false;
  const holder = { get current() { return on ? { async read() { return { title: 'T', url: 'https://x.y', text: 'hi', length: 2, truncated: false }; } } : null; } };
  const { actions } = rig(holder);
  assert.ok(!actions.names.includes('browser_read'), 'off at build time');
  on = true;
  assert.ok(actions.names.includes('browser_read'), 'on after the switch, same object');
});

test('browser actions go through the same consent cards as the mouse', () => {
  // Same gate, same words: the safety story does not fork because the action
  // now happens inside a page instead of on a screenshot.
  assert.ok(preview({ name: 'browser_click', args: { selector: '#buy' } }, { targetName: 'Buy now' }));
  assert.ok(preview({ name: 'browser_click', args: { selector: '#order' } }, { targetName: 'Place order' }));
  assert.ok(preview({ name: 'browser_type', args: { selector: '#c', submit: true } }, {}));
  assert.ok(preview({ name: 'browser_press', args: { key: 'ctrl+enter' } }, {}));
  assert.equal(preview({ name: 'browser_click', args: { selector: '#next' } }, { targetName: 'Next page' }), null);
  assert.equal(preview({ name: 'browser_read' }, {}), null);
  assert.equal(preview({ name: 'browser_open', args: { url: 'https://x.y' } }, {}), null);
});
