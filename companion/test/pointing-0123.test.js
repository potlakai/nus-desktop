'use strict';
// Pointing measured on publik-fast, 2026-11-15 (ventures/nus/conditor/pointing-0123):
//   - a reply that points AND says [DONE] ("this click finishes it") is pointed at, not dropped;
//   - a box with its corner in pixels and its size in fractions is converted, not refused;
//   - a publik stream that sends all its text and then hangs ends with that text.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { GuideSession, endsHere } = require('../src/guide/session');
const { validatePoint } = require('../src/guide/pointing');
const { streamOpenAI } = require('../src/llm');

test('[DONE] ends the walk only when there is nothing left to click', () => {
  const el = { kind: 'element', id: 2 };
  assert.equal(endsHere({ instruction: 'Click the toggle to turn it on.', target: el, done: true }), false);
  assert.equal(endsHere({ instruction: 'Submitted. You are done.', target: null, done: true }), true);
  assert.equal(endsHere({ instruction: 'That setting is already on.', target: el, done: true }), true);
  assert.equal(endsHere({ instruction: 'There is nothing to click here.', target: el, done: true }), true);
  assert.equal(endsHere({ instruction: 'Click Insert.', target: el, done: false }), false);
});

function harness(replies) {
  const sent = [];
  const els = [{ id: 2, name: 'Switch', type: 'Button', rect: { x: 1500, y: 900, w: 160, h: 40 } }];
  const probe = {
    available: true, watching: null,
    async request(op) {
      if (op === 'fg') return { hwnd: 77, title: 'Settings', process: 'SystemSettings', pid: 500 };
      if (op === 'uia.list') return { elements: els };
      return {};
    },
    async watch(o) { probe.watching = o; return { ok: true }; },
    async unwatch() { probe.watching = null; return { ok: true }; },
    status() { return { watching: probe.watching }; },
  };
  let n = 0;
  const g = new GuideSession({
    capture: async () => ({ dataUrl: 'data:image/png;base64,AAAA', width: 1280, height: 720, pxWidth: 1920, pxHeight: 1080, display: { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 } }),
    probe,
    llm: () => ({ ready: true, provider: 'publik', async complete() { return replies.shift(); } }),
    send: (ch, p) => sent.push([ch, p]),
    screenToDip: (p) => p, dipToScreen: (p) => p,
    winBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    hashCapture: () => { n += 1; const h = Uint8Array.from({ length: 32 }, (_, i) => (n * 73 + i * 31) & 255); return { whole: h, crop: h }; },
    selfPid: 999, log: () => {}, sleep: async () => {}, now: () => 1000, onKeep: () => {},
  });
  return { g, sent };
}

test('a one-click task that the model marks [DONE] still gets its thread', async () => {
  const { g, sent } = harness(['Click the Switch to turn it on.\n[POINT:2]\n[CONF:0.95]\n[DONE]']);
  await g.start('how do I turn it on', 'typed');
  const t = sent.filter(([c]) => c === 'guide:target').pop();
  assert.ok(t, 'a thread is drawn');
  assert.deepEqual(t[1].bbox, { x: 1500, y: 900, w: 160, h: 40 });
  assert.notEqual(g.status().state, 'done');
});

test('a box with its corner in pixels and its size in fractions is converted', () => {
  const v = validatePoint({ instruction: 'Click Theme, top right.', target: { kind: 'bbox', x: 1117, y: 148, w: 0.06, h: 0.025, label: 'Theme' }, confidence: 0.95 }, [], { verified: true, image: { width: 1568, height: 882 } });
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'bbox (pixels converted)');
  assert.ok(Math.abs(v.reply.target.x - 1117 / 1568) < 1e-9 && Math.abs(v.reply.target.y - 148 / 882) < 1e-9);
  assert.equal(v.reply.target.w, 0.06);
  // Without the image size it is still refused, as before.
  assert.equal(validatePoint({ instruction: 'Click Theme.', target: { kind: 'bbox', x: 1117, y: 148, w: 0.06, h: 0.025 }, confidence: 0.95 }, []).ok, false);
});

// A local server speaking the chat-completions stream. hang: send the text, then nothing.
function sse({ hang }) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (d) => res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: d, finish_reason: null }] }) + '\n\n');
      chunk({ role: 'assistant', content: '' });
      for (const p of ['Click ', 'Insert.', '\n[POINT:3]']) chunk({ content: p });
      if (hang) return; // the connection stays open
      res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

test('a publik stream that hangs after its text ends with that text', async () => {
  const server = await sse({ hang: true });
  try {
    const t0 = Date.now();
    const text = await streamOpenAI({ apiKey: 'test', model: 'm', system: 's', turns: [{ role: 'user', text: 'q' }], maxTokens: 50, onToken: () => {}, baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', idleAfterTextMs: 300 });
    assert.equal(text, 'Click Insert.\n[POINT:3]');
    assert.ok(Date.now() - t0 < 3000);
  } finally { server.closeAllConnections(); server.close(); }
});

test('a normal stream is read to its end, and a stop still stops it', async () => {
  const server = await sse({ hang: false });
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  try {
    assert.equal(await streamOpenAI({ apiKey: 'test', model: 'm', system: 's', turns: [{ role: 'user', text: 'q' }], maxTokens: 50, onToken: () => {}, baseURL: base, idleAfterTextMs: 300 }), 'Click Insert.\n[POINT:3]');
    const stop = new AbortController(); stop.abort();
    await assert.rejects(streamOpenAI({ apiKey: 'test', model: 'm', system: 's', turns: [{ role: 'user', text: 'q' }], maxTokens: 50, onToken: () => {}, baseURL: base, signal: stop.signal, idleAfterTextMs: 300 }));
  } finally { server.closeAllConnections(); server.close(); }
});
