'use strict';
// Private fields are refused in code on every pointing path, not only in the prompt.
const test = require('node:test');
const assert = require('node:assert/strict');
const { sensitiveTarget, looksSecret, REFUSAL } = require('../src/guide/sensitive');
const { GuideSession } = require('../src/guide/session');

test('sensitiveTarget reads the password flag, field names and automation ids; buttons are fine', () => {
  assert.equal(sensitiveTarget({ type: 'Edit', name: 'Password' }), true);
  assert.equal(sensitiveTarget({ type: 'Edit', name: '', isPassword: true }), true);
  assert.equal(sensitiveTarget({ type: 'Edit', name: 'Card number' }), true);
  assert.equal(sensitiveTarget({ type: 'Edit', name: '', automationId: 'txtSocialSecurityNumber' }), true);
  assert.equal(sensitiveTarget({ type: 'Edit', name: 'Verification code' }), true);
  assert.equal(sensitiveTarget({ type: 'Edit', name: 'Search' }), false);
  assert.equal(sensitiveTarget({ type: 'Button', name: 'Change password' }), false, 'a button about passwords is not a field');
  assert.equal(sensitiveTarget(null), false);
  assert.equal(looksSecret('4111 1111 1111 1111'), true);
  assert.equal(looksSecret('room 204'), false);
});

const CAP = { dataUrl: 'data:image/jpeg;base64,AAAA', width: 1280, height: 720, pxWidth: 1920, pxHeight: 1080, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } };
const ELEMENTS = [
  { id: 1, name: 'Username', type: 'Edit', rect: { x: 100, y: 200, w: 200, h: 24 } },
  { id: 2, name: 'Password', type: 'Edit', rect: { x: 100, y: 240, w: 200, h: 24 }, isPassword: true },
  { id: 3, name: 'Sign in', type: 'Button', rect: { x: 100, y: 280, w: 100, h: 30 } },
];
function probe(findResult) {
  return {
    available: true, watching: null,
    async request(op) { if (op === 'fg') return { hwnd: 7, title: 'Login', process: 'chrome', pid: 5 }; if (op === 'uia.list') return { elements: ELEMENTS }; if (op === 'uia.find') return findResult || { element: null }; return {}; },
    async watch() { return { ok: true }; }, async unwatch() { return { ok: true }; }, status() { return { watching: null }; },
  };
}
function session(reply, extra = {}) {
  const sent = [];
  const g = new GuideSession(Object.assign({
    capture: async () => CAP, probe: probe(),
    llm: () => ({ ready: true, provider: 'test', async complete() { return reply; } }),
    send: (ch, p) => sent.push([ch, p]), screenToDip: (p) => p, dipToScreen: (p) => p,
    winBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }), hashCapture: () => null, selfPid: 999, log: () => {}, sleep: async () => {}, now: () => 1000,
  }, extra));
  return { g, sent, last: (ch) => { const m = sent.filter(([c]) => c === ch); return m.length ? m[m.length - 1][1] : null; } };
}

test('the model pointing at the password box is refused with the spoken reason, and the thread stays home', async () => {
  const { g, sent, last } = session('Type your password here. [POINT:2] [CONF:0.9]');
  await g.start('log in to canvas', 'voice');
  assert.equal(sent.filter(([c]) => c === 'guide:target').length, 0);
  assert.equal(last('guide:bubble').text, REFUSAL);
  assert.equal(g.status().state, 'explaining');
  g.dismiss('test');
});

test('the username box and the sign-in button are still pointed at', async () => {
  const a = session('Type your username here. [POINT:1] [CONF:0.9]');
  await a.g.start('log in', 'typed');
  assert.deepEqual(a.last('guide:target').bbox, { x: 100, y: 200, w: 200, h: 24 });
  a.g.dismiss('test');
  const b = session('Click Sign in. [POINT:3] [CONF:0.9]');
  await b.g.start('log in', 'typed');
  assert.deepEqual(b.last('guide:target').bbox, { x: 100, y: 280, w: 100, h: 30 });
  b.g.dismiss('test');
});

test('a kept walkthrough never replays into a private field', async () => {
  const walkthroughs = { find: () => ({ key: 'chrome::log-in', steps: [{ instruction: 'Type your password', target: { name: 'Password', type: 'Edit' } }] }), miss: () => false, record: () => {} };
  const { g, sent, last } = session('', { walkthroughs, probe: probe({ element: ELEMENTS[1], score: 100 }) });
  await g.start('log in', 'typed');
  assert.equal(sent.filter(([c]) => c === 'guide:target').length, 0);
  assert.equal(last('guide:bubble').text, REFUSAL);
  g.dismiss('test');
});
