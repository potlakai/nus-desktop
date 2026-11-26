'use strict';
// The Zen controller, driven by a scripted socket. No browser is running here:
// the point is that the protocol frames, the tab picking and the error words
// are right, because those are what break silently on a real machine.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createZen, createClient, endpointFor, flatten, pickPage, adviceFor, BidiError, INTERNAL_URL } = require('../src/browser/zen');

// A WebSocket that answers like Zen. handlers: method -> (params) => result.
function fakeSocket(handlers = {}, { failOn = {}, closeOnOpen = false } = {}) {
  const sockets = [];
  class Fake {
    constructor(url) {
      this.url = url; this.sent = []; this.readyState = 0;
      this.listeners = { open: [], message: [], close: [], error: [] };
      sockets.push(this);
      setImmediate(() => {
        if (closeOnOpen) { this.readyState = 3; for (const f of this.listeners.close) f({}); return; }
        this.readyState = 1;
        for (const f of this.listeners.open) f({});
      });
    }
    addEventListener(type, fn) { (this.listeners[type] || (this.listeners[type] = [])).push(fn); }
    send(raw) {
      const msg = JSON.parse(raw);
      this.sent.push(msg);
      const fail = failOn[msg.method];
      if (fail) {
        setImmediate(() => this.emit({ id: msg.id, type: 'error', error: fail.error || 'invalid argument', message: fail.message }));
        return;
      }
      const h = handlers[msg.method];
      const result = typeof h === 'function' ? h(msg.params) : (h || {});
      setImmediate(() => this.emit({ id: msg.id, type: 'success', result }));
    }
    emit(obj) { for (const f of this.listeners.message) f({ data: JSON.stringify(obj) }); }
    close() { this.readyState = 3; for (const f of this.listeners.close) f({}); }
  }
  Fake.sockets = sockets;
  return Fake;
}

const TREE = {
  contexts: [
    {
      context: 'ctx-1', url: 'zen://newtab', children: [
        { context: 'ctx-2', url: 'https://canvas.instructure.com/courses/1', parent: 'ctx-1', children: [] },
      ],
    },
    { context: 'ctx-3', url: 'about:preferences', children: [] },
  ],
};

test('the endpoint is a BiDi session on the loopback port, never CDP', () => {
  assert.equal(endpointFor(), 'ws://127.0.0.1:9222/session');
  assert.equal(endpointFor({ port: 9333 }), 'ws://127.0.0.1:9333/session');
  assert.equal(endpointFor({ host: 'localhost', port: 1 }), 'ws://localhost:1/session');
});

test('the tree flattens to pages, and browser surfaces are not pages', () => {
  const pages = flatten(TREE);
  assert.deepEqual(pages.map((p) => p.id), ['ctx-2', 'ctx-3']);
  assert.equal(pages[0].url, 'https://canvas.instructure.com/courses/1');
  assert.ok(INTERNAL_URL.test('about:preferences'));
  assert.ok(INTERNAL_URL.test('moz-extension://abc/page.html'));
  assert.ok(!INTERNAL_URL.test('https://example.com'));
  // The one the operator is looking at is a real page, not the new-tab shell.
  assert.equal(pickPage(pages).id, 'ctx-2');
  assert.equal(pickPage([{ id: 'x', url: 'about:blank' }]), null);
  assert.equal(pickPage([]), null);
  assert.equal(pickPage(null), null);
});

test('a request is numbered, answered, and the reply is the result only', async () => {
  const Fake = fakeSocket({ 'browsingContext.getTree': TREE });
  const c = createClient({ WebSocketImpl: Fake, url: endpointFor() });
  const r = await c.send('browsingContext.getTree', {});
  assert.deepEqual(r, TREE);
  assert.equal(Fake.sockets[0].sent[0].id, 1);
  assert.equal(Fake.sockets[0].sent[0].method, 'browsingContext.getTree');
  c.close();
});

test('a protocol error is a BidiError with a kind, not a bare throw', async () => {
  const Fake = fakeSocket({}, { failOn: { 'browsingContext.navigate': { error: 'no such frame', message: 'nope' } } });
  const c = createClient({ WebSocketImpl: Fake, url: endpointFor() });
  await assert.rejects(c.send('browsingContext.navigate', {}), (e) => {
    assert.ok(e instanceof BidiError);
    assert.equal(e.kind, 'protocol');
    assert.match(e.message, /nope/);
    return true;
  });
  c.close();
});

test('a browser that refuses a second controller is reported as busy, with words to act on', async () => {
  const Fake = fakeSocket({}, { failOn: { 'session.new': { message: 'Session already started by another client' } } });
  const c = createClient({ WebSocketImpl: Fake, url: endpointFor() });
  await assert.rejects(c.send('session.new', {}), (e) => {
    assert.equal(e.kind, 'busy');
    assert.match(adviceFor(e), /Another program is already driving Zen/);
    return true;
  });
  c.close();
});

test('a browser that is not there says how to make it there, and says nothing false', async () => {
  const Fake = fakeSocket({}, { closeOnOpen: true });
  const c = createClient({ WebSocketImpl: Fake, url: endpointFor() });
  await assert.rejects(c.send('browsingContext.getTree', {}), (e) => {
    assert.equal(e.kind, 'offline');
    const advice = adviceFor(e);
    assert.match(advice, /Quit Zen and reopen it with remote debugging on/);
    assert.match(advice, /session restore/);
    return true;
  });
});

test('a request nobody answers times out instead of hanging the task', async () => {
  // A socket that opens and then swallows everything: the browser is there but
  // the tab is stuck behind a dialog, which is the case that used to hang a run.
  class Silent {
    constructor() { this.listeners = { open: [], message: [], close: [], error: [] }; setImmediate(() => { for (const f of this.listeners.open) f({}); }); }
    addEventListener(type, fn) { this.listeners[type].push(fn); }
    send() { /* no answer, ever */ }
    close() { for (const f of this.listeners.close) f({}); }
  }
  const c = createClient({ WebSocketImpl: Silent, url: endpointFor(), timeoutMs: 30 });
  const kind = await c.send('browsingContext.getTree', {}).then(() => 'answered', (e) => e.kind);
  assert.equal(kind, 'timeout');
  assert.match(adviceFor(new BidiError('x', { kind: 'timeout' })), /showing a dialog/);
  c.close();
});

test('reading a page is bounded, and says whether it was cut', async () => {
  const long = 'x'.repeat(5000);
  const Fake = fakeSocket({
    'browsingContext.getTree': TREE,
    'script.evaluate': { result: { value: { title: 'Lab 3', url: 'https://canvas.instructure.com/x', text: long } } },
  });
  const zen = createZen({ WebSocketImpl: Fake });
  const page = await zen.read({ max: 1000 });
  assert.equal(page.id, 'ctx-2');
  assert.equal(page.title, 'Lab 3');
  assert.equal(page.text.length, 1000);
  assert.equal(page.length, 5000);
  assert.equal(page.truncated, true, 'a caller must know it did not see the whole page');
  assert.ok(page.text.length <= 20000);
});

test('a click is a real pointer press at the element, and its label is what the card shows', async () => {
  const calls = [];
  const Fake = fakeSocket({
    'browsingContext.getTree': TREE,
    'script.evaluate': { result: { value: { x: 120.5, y: 340.25, w: 80, h: 20, label: 'Submit assignment' } } },
    'input.performActions': (p) => { calls.push(p); return {}; },
  });
  const zen = createZen({ WebSocketImpl: Fake });
  const out = await zen.click('#submit');
  assert.equal(out.x, 121);
  assert.equal(out.y, 340);
  assert.equal(out.label, 'Submit assignment');
  const actions = calls[0].actions[0];
  assert.equal(actions.type, 'pointer');
  assert.equal(actions.parameters.pointerType, 'mouse');
  assert.deepEqual(actions.actions.map((a) => a.type), ['pointerMove', 'pointerDown', 'pointerUp']);
  assert.equal(actions.actions[0].origin, 'viewport');
  // The card gets a human name for the thing about to be pressed.
  const described = await zen.describe('click', { selector: '#submit' });
  assert.equal(described.targetName, 'Submit assignment');
  assert.equal(described.action, 'click');
});

test('a click on something that is not on the page fails as a page error, not a silent no-op', async () => {
  const Fake = fakeSocket({
    'browsingContext.getTree': TREE,
    'script.evaluate': { result: { value: null } },
  });
  const zen = createZen({ WebSocketImpl: Fake });
  await assert.rejects(zen.click('#nothing'), (e) => {
    assert.equal(e.kind, 'page');
    assert.match(e.message, /Nothing on the page matches #nothing/);
    return true;
  });
});

test('typing goes through the value setter and fires input and change, so React sees it', async () => {
  let expr = '';
  const Fake = fakeSocket({
    'browsingContext.getTree': TREE,
    'script.evaluate': (p) => { expr = p.expression; return { result: { value: { ok: true } } }; },
  });
  const zen = createZen({ WebSocketImpl: Fake });
  const out = await zen.type('#body', 'the demo is Thursday', { submit: false });
  assert.equal(out.selector, '#body');
  assert.equal(out.submit, false);
  assert.match(expr, /HTMLTextAreaElement\.prototype/);
  assert.match(expr, /getOwnPropertyDescriptor/);
  assert.match(expr, /new Event\("input", \{ bubbles: true \}\)/);
  assert.match(expr, /new Event\("change", \{ bubbles: true \}\)/);
  assert.match(expr, /the demo is Thursday/);
  assert.ok(expr.trim().endsWith('"#body","the demo is Thursday",false)'), 'submit is passed through as false');
});

test('submit is an explicit request, and the card is told about it', async () => {
  let expr = '';
  const Fake = fakeSocket({
    'browsingContext.getTree': TREE,
    'script.evaluate': (p) => { expr = p.expression; return { result: { value: { ok: true } } }; },
  });
  const zen = createZen({ WebSocketImpl: Fake });
  await zen.type('#body', 'done', { submit: true });
  assert.match(expr, /requestSubmit/);
  assert.equal(expr.trim().endsWith('true)'), true, 'submit is passed to the page as true');
  const card = await zen.describe('type', { selector: '#body', submit: true });
  assert.equal(card.submit, true, 'the consent card must know this type sends');
});

test('navigate names the tab it moved, so a later click cannot land in a stale one', async () => {
  const sent = [];
  const Fake = fakeSocket({
    'browsingContext.getTree': TREE,
    'browsingContext.navigate': (p) => { sent.push(p); return { navigation: 'nav-1', url: p.url }; },
  });
  const zen = createZen({ WebSocketImpl: Fake });
  const out = await zen.navigate('https://example.com/lab');
  assert.equal(out.id, 'ctx-2');
  assert.equal(sent[0].context, 'ctx-2');
  assert.equal(sent[0].url, 'https://example.com/lab');
  assert.equal(sent[0].wait, 'complete');
});

test('a key press is one named key, not a guessing game', async () => {
  const calls = [];
  const Fake = fakeSocket({
    'browsingContext.getTree': TREE,
    'input.performActions': (p) => { calls.push(p); return {}; },
  });
  const zen = createZen({ WebSocketImpl: Fake });
  await zen.press('\uE007');
  assert.deepEqual(calls[0].actions[0].actions.map((a) => a.type), ['keyDown', 'keyUp']);
  assert.equal(calls[0].actions[0].actions[0].value, '\uE007');
  await assert.rejects(zen.press(''), (e) => e.kind === 'protocol');
});

test('a screenshot comes back as a data URL the existing image path can carry', async () => {
  const Fake = fakeSocket({
    'browsingContext.getTree': TREE,
    'browsingContext.captureScreenshot': { data: 'AAAA' },
  });
  const zen = createZen({ WebSocketImpl: Fake });
  const shot = await zen.screenshot();
  assert.equal(shot.dataUrl, 'data:image/png;base64,AAAA');
});

test('status answers instead of throwing, so the caller can decide whether to offer it', async () => {
  const ok = createZen({ WebSocketImpl: fakeSocket({ 'browsingContext.getTree': TREE }) });
  const s1 = await ok.status();
  assert.equal(s1.available, true);
  assert.equal(s1.pages, 2);

  const gone = createZen({ WebSocketImpl: fakeSocket({}, { closeOnOpen: true }) });
  const s2 = await gone.status();
  assert.equal(s2.available, false);
  assert.equal(s2.kind, 'offline');
  assert.match(s2.error, /reopen it with remote debugging/);
});

test('no page open is said plainly, and nothing is attempted on a tab that is not there', async () => {
  const Fake = fakeSocket({ 'browsingContext.getTree': { contexts: [{ context: 'c', url: 'about:blank', children: [] }] } });
  const zen = createZen({ WebSocketImpl: Fake });
  await assert.rejects(zen.read(), (e) => {
    assert.equal(e.kind, 'page');
    assert.match(e.message, /No page is open in Zen/);
    return true;
  });
});

test('an empty address is refused before a navigation is sent', async () => {
  const Fake = fakeSocket({ 'browsingContext.getTree': TREE });
  const zen = createZen({ WebSocketImpl: Fake });
  await assert.rejects(zen.navigate('   '), (e) => e.kind === 'protocol');
  const sent = Fake.sockets.flatMap((s) => s.sent);
  assert.equal(sent.filter((m) => m.method === 'browsingContext.navigate').length, 0, 'nothing was sent to the browser');
});

test('the consent shape is a label, not a second opinion on safety', async () => {
  const zen = createZen({ WebSocketImpl: fakeSocket({ 'browsingContext.getTree': TREE }) });
  // describe() names what would be touched and never decides whether it is
  // risky: that judgement is consent.js's, and it must stay in one place.
  const press = await zen.describe('press', { key: 'Enter' });
  assert.deepEqual(press, { action: 'press', keys: 'Enter' });
  for (const name of ['click', 'type', 'press', 'navigate']) {
    const d = await zen.describe(name, { selector: '#a', url: 'https://x', key: 'a' });
    assert.ok(!('risky' in d) && !('confirm' in d), name + ' must not carry a verdict');
  }
});
