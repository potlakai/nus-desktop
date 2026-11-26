'use strict';
// 0.1.29: the 0.1.24 pointing fixes back, made smoother.
//   - the click on a step the model marked [DONE] ends the walk on the spot, with
//     no second screenshot and model call (and no "thinking" spin) after it;
//   - any other step still reads the screen after the click, as before;
//   - a publik stream that goes quiet mid-sentence gets one more idle window
//     before it is taken as it is; one that has finished a sentence does not.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { GuideSession } = require('../src/guide/session');
const { streamOpenAI, LOOKS_FINISHED } = require('../src/llm');

function harness(replies) {
  const sent = [];
  const calls = [];
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
    llm: () => ({ ready: true, provider: 'publik', async complete(p) { calls.push(p); return replies.shift(); } }),
    send: (ch, p) => sent.push([ch, p]),
    screenToDip: (p) => p, dipToScreen: (p) => p,
    winBounds: () => ({ x: 0, y: 0, width: 1920, height: 1040 }),
    hashCapture: () => { n += 1; const h = Uint8Array.from({ length: 32 }, (_, i) => (n * 73 + i * 31) & 255); return { whole: h, crop: h }; },
    selfPid: 999, log: () => {}, sleep: async () => {}, now: () => 1000, onKeep: () => {},
  });
  return { g, sent, calls };
}

// The thread is out; the app reports it arrived, then the person clicks the middle of the box.
async function clickTarget(g) {
  g.onArrived && g.onArrived();
  g.state = 'pointing';
  await g.onClick({ x: 1580, y: 920 });
}

test('the click on a [DONE] step finishes the walk with no second model call', async () => {
  const { g, sent, calls } = harness(['Click the Switch to turn it on.\n[POINT:2]\n[CONF:0.95]\n[DONE]']);
  await g.start('turn on the switch', 'typed');
  assert.ok(sent.some(([c]) => c === 'guide:target'), 'the thread is drawn first');
  const before = calls.length;
  await clickTarget(g);
  assert.equal(calls.length, before, 'no model call after the last click');
  assert.equal(g.status().state, 'done');
  const bubble = sent.filter(([c, p]) => c === 'guide:bubble' && p.task === 'guide').pop();
  assert.equal(bubble[1].text, 'Done.');
});

test('a step that is not the last still reads the screen after the click', async () => {
  const { g, calls } = harness([
    'Click the Switch.\n[POINT:2]\n[CONF:0.95]',
    'That is it, it is on now.\n[DONE]',
  ]);
  await g.start('turn on the switch', 'typed');
  const before = calls.length;
  await clickTarget(g);
  assert.equal(calls.length, before + 1, 'one more model call for the next step');
  assert.equal(g.status().state, 'done');
});

test('what counts as a finished reply', () => {
  for (const s of ['Click Insert.', 'Click Insert.\n[POINT:3]', 'Done!', 'Is it on?', 'Open Settings:', 'line one\n']) assert.ok(LOOKS_FINISHED.test(s), s);
  for (const s of ['Click ', 'Click the Night', 'The total is 4']) assert.ok(!LOOKS_FINISHED.test(s), s);
});

// A local chat-completions stream that plays a script of [ms, text] then hangs.
function sse(script) {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (d) => res.write('data: ' + JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 1, model: 'm', choices: [{ index: 0, delta: d, finish_reason: null }] }) + '\n\n');
      chunk({ role: 'assistant', content: '' });
      for (const [ms, text] of script) { if (ms) await new Promise((r) => setTimeout(r, ms)); if (!res.writableEnded) chunk({ content: text }); }
      // and then nothing: the connection stays open
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}
const ask = (port, idle) => streamOpenAI({ apiKey: 'test', model: 'm', system: 's', turns: [{ role: 'user', text: 'q' }], maxTokens: 50, onToken: () => {}, baseURL: 'http://127.0.0.1:' + port + '/v1', idleAfterTextMs: idle });

test('a stream that pauses mid-sentence longer than one idle window is not cut short', async () => {
  const server = await sse([[0, 'Click '], [450, 'Insert.'], [0, '\n[POINT:3]']]);
  try {
    assert.equal(await ask(server.address().port, 300), 'Click Insert.\n[POINT:3]');
  } finally { server.closeAllConnections(); server.close(); }
});

test('a stream that finished its sentence ends after one idle window', async () => {
  const server = await sse([[0, 'Click Insert.'], [0, '\n[POINT:3]']]);
  try {
    const t0 = Date.now();
    assert.equal(await ask(server.address().port, 300), 'Click Insert.\n[POINT:3]');
    const ms = Date.now() - t0;
    assert.ok(ms < 550, 'ended after about one window, took ' + ms + ' ms');
  } finally { server.closeAllConnections(); server.close(); }
});

test('a stream stuck mid-sentence still ends, after two windows', async () => {
  const server = await sse([[0, 'Click the Night']]);
  try {
    const t0 = Date.now();
    assert.equal(await ask(server.address().port, 300), 'Click the Night');
    const ms = Date.now() - t0;
    assert.ok(ms >= 550 && ms < 1500, 'two windows, took ' + ms + ' ms');
  } finally { server.closeAllConnections(); server.close(); }
});
