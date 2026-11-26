'use strict';
// Driving the operator's own browser, properly.
//
// Zen is Firefox under the skin, so Chrome DevTools Protocol does not fit: the
// port Zen opens for remote control speaks WebDriver BiDi instead, one JSON
// message per frame over a WebSocket. Node 22 has WebSocket built in, so this
// costs no dependency.
//
//   zen --remote-debugging-port=9222      then connect to ws://127.0.0.1:9222/session
//
// Two limits are the protocol's, not ours, and the messages say so plainly
// rather than letting a caller guess:
//   - the flag cannot be added to a browser that is already running, so the
//     first attach needs Zen quit (session restore brings the tabs back);
//   - one BiDi session per browser, so a second controller gets a refusal.
//
// Nothing here clicks on a guess. Every action is addressed to a browsing
// context (a tab) that was read from the browser moments before, and the
// consent gate lives in hands/consent.js: this module reports what an action
// would touch (describe) so the caller can put up the same card it uses for the
// mouse, rather than growing a second, weaker safety story.

const DEFAULT_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';
const REQUEST_TIMEOUT_MS = 15000;
const CONNECT_TIMEOUT_MS = 5000;
const TEXT_MAX = 20000;
const PAGE_MAX = 50;

function clip(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// A BiDi error the caller can act on: offline, refused, or the page's fault.
class BidiError extends Error {
  constructor(message, { kind = 'protocol', status = null, command = null } = {}) {
    super(message);
    this.name = 'BidiError';
    this.kind = kind;          // 'offline' | 'busy' | 'protocol' | 'timeout' | 'page'
    this.status = status;
    this.command = command;
  }
}

// The words a person needs, not the protocol's.
function adviceFor(err) {
  const kind = err && err.kind;
  if (kind === 'offline') return 'Zen is not listening for remote control. Quit Zen and reopen it with remote debugging on, then try again; your tabs come back with session restore.';
  if (kind === 'busy') return 'Another program is already driving Zen. Close it, or point this at a second browser with its own debugging port.';
  if (kind === 'timeout') return 'Zen did not answer in time. It may be showing a dialog; check the browser window.';
  if (kind === 'page') {
    // The page's own sentence is the useful part ("Nothing on the page matches
    // #submit"); the instruction stops a model guessing a second selector.
    const own = clip(err && err.message, 160);
    return (own || 'The page did not have what the action named.') + ' Read the page again before trying a different selector.';
  }
  return 'Zen refused the request: ' + clip(err && err.message, 160);
}

// One WebSocket, numbered requests, binary-safe frames. The socket is injected
// so tests can drive it with a scripted fake instead of a real browser.
function createClient({ WebSocketImpl = globalThis.WebSocket, url, timeoutMs = REQUEST_TIMEOUT_MS, now = Date.now } = {}) {
  let ws = null;
  let nextId = 1;
  let opened = false;
  let closed = false;
  const pending = new Map();
  const listeners = new Set();

  function settle(id, fn) { const p = pending.get(id); if (!p) return; pending.delete(id); fn(p); }

  function onMessage(raw) {
    let msg = null;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    if (msg.id != null && pending.has(msg.id)) {
      if (msg.type === 'error') {
        const kind = /session already started|session not started/i.test(String(msg.message || '')) ? 'busy' : 'protocol';
        settle(msg.id, (p) => p.reject(new BidiError(clip(msg.message || msg.error || 'refused', 300), { kind, status: msg.error, command: p.command })));
      } else {
        settle(msg.id, (p) => p.resolve(msg.result || {}));
      }
      return;
    }
    // Events: browsingContext.* and log.* arrive here. A caller that cares
    // subscribes; nobody has to.
    if (msg.type === 'event') for (const fn of listeners) { try { fn(msg); } catch { /* a listener never breaks the pipe */ } }
  }

  function failAll(err) { for (const id of [...pending.keys()]) settle(id, (p) => p.reject(err)); }

  function open() {
    if (opened) return Promise.resolve();
    if (!WebSocketImpl) return Promise.reject(new BidiError('No WebSocket in this runtime.', { kind: 'offline' }));
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws && ws.close(); } catch { /* already gone */ }
        reject(new BidiError('Zen did not answer on ' + url + '.', { kind: 'offline' }));
      }, CONNECT_TIMEOUT_MS);
      try { ws = new WebSocketImpl(url); } catch (e) {
        clearTimeout(timer);
        return reject(new BidiError(clip(e.message, 160), { kind: 'offline' }));
      }
      ws.addEventListener('open', () => {
        if (settled) return;
        settled = true; clearTimeout(timer); opened = true; closed = false;
        resolve();
      });
      ws.addEventListener('message', (ev) => onMessage(ev && ev.data != null ? ev.data : ev));
      ws.addEventListener('close', () => {
        opened = false; closed = true;
        clearTimeout(timer);
        if (!settled) { settled = true; reject(new BidiError('Zen closed the connection.', { kind: 'offline' })); return; }
        failAll(new BidiError('Zen closed the connection.', { kind: 'offline' }));
      });
      ws.addEventListener('error', () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new BidiError('Could not reach Zen on ' + url + '.', { kind: 'offline' })); }
      });
    });
  }

  async function send(method, params = {}, { timeout = timeoutMs } = {}) {
    await open();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!pending.has(id)) return;
        pending.delete(id);
        reject(new BidiError('No answer to ' + method + ' in ' + timeout + ' ms.', { kind: 'timeout', command: method }));
      }, timeout);
      pending.set(id, {
        command: method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { ws.send(JSON.stringify({ id, method, params })); } catch (e) {
        clearTimeout(timer); pending.delete(id);
        reject(new BidiError(clip(e.message, 160), { kind: 'offline', command: method }));
      }
    });
  }

  function close() {
    opened = false;
    failAll(new BidiError('Closed.', { kind: 'offline' }));
    try { ws && ws.close(); } catch { /* already gone */ }
    ws = null;
  }

  return {
    open, send, close,
    on: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    get isOpen() { return opened && !closed; },
    get url() { return url; },
    // For tests and for a caller that wants to know whether this is worth trying.
    get stats() { return { pending: pending.size, nextId }; },
  };
}

// The address a browser listens on. Kept as a pure function so the port can be
// configured without a browser to try it on.
function endpointFor({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return 'ws://' + host + ':' + Number(port) + '/session';
}

// A tab, flattened from the tree: children carry their own ids, and only leaves
// are pages anyone can read.
function flatten(tree) {
  const out = [];
  const walk = (c, depth) => {
    if (!c || out.length >= PAGE_MAX) return;
    const kids = Array.isArray(c.children) ? c.children : [];
    if (!kids.length) out.push({ id: c.context, url: String(c.url || ''), parent: c.parent || null, depth });
    for (const k of kids) walk(k, depth + 1);
  };
  for (const c of (tree && Array.isArray(tree.contexts) ? tree.contexts : [])) walk(c, 0);
  return out;
}

// The one tab the operator is looking at: the frontmost top-level context whose
// url is a page and not a browser surface. about:* and the extension pages are
// skipped, because reading them tells the model nothing about the task.
const INTERNAL_URL = /^(?:about:|chrome:|resource:|moz-extension:|jar:|view-source:)/i;
function pickPage(pages) {
  const usable = (pages || []).filter((p) => p && p.url && !INTERNAL_URL.test(p.url));
  return usable[0] || null;
}

function createZen({ WebSocketImpl = globalThis.WebSocket, host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = REQUEST_TIMEOUT_MS, client = null } = {}) {
  const url = endpointFor({ host, port });
  let c = client;
  const conn = () => { if (!c) c = createClient({ WebSocketImpl, url, timeoutMs }); return c; };

  async function pages() {
    const tree = await conn().send('browsingContext.getTree', {}, { timeout: timeoutMs });
    return flatten(tree);
  }

  async function current() {
    const p = pickPage(await pages());
    if (!p) throw new BidiError('No page is open in Zen.', { kind: 'page' });
    return p;
  }

  // What is on the page, as text. Bounded: a long article must not become the
  // whole prompt, and a page must never be able to ask for more than this.
  async function read({ pageId = null, max = TEXT_MAX } = {}) {
    const id = pageId || (await current()).id;
    const r = await conn().send('script.evaluate', {
      expression: '({ title: document.title, url: location.href, text: (document.body ? document.body.innerText : "") || "" })',
      target: { context: id },
      awaitPromise: false,
      resultOwnership: 'none',
    }, { timeout: timeoutMs });
    const v = r && r.result && r.result.value;
    if (!v || typeof v !== 'object') throw new BidiError('The page returned nothing readable.', { kind: 'page' });
    const text = String(v.text || '');
    return {
      id,
      title: clip(v.title, 200),
      url: String(v.url || ''),
      text: text.slice(0, Math.max(0, Math.min(Number(max) || TEXT_MAX, TEXT_MAX))),
      truncated: text.length > (Number(max) || TEXT_MAX),
      length: text.length,
    };
  }

  async function navigate(address, { pageId = null, wait = 'complete' } = {}) {
    const target = address == null ? '' : String(address).trim();
    if (!target) throw new BidiError('No address to open.', { kind: 'protocol' });
    const id = pageId || (await current()).id;
    await conn().send('browsingContext.navigate', { context: id, url: target, wait }, { timeout: Math.max(timeoutMs, 30000) });
    return { id, url: target };
  }

  // The centre of the element a selector names, in CSS pixels, or null.
  async function locate(selector, pageId) {
    const r = await conn().send('script.evaluate', {
      expression: '(function (sel) { const el = document.querySelector(sel); if (!el) return null;'
        + ' const b = el.getBoundingClientRect();'
        + ' return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height,'
        + ' label: (el.innerText || el.value || el.getAttribute("aria-label") || el.name || "").slice(0, 120) }; })('
        + JSON.stringify(String(selector || '')) + ')',
      target: { context: pageId },
      awaitPromise: false,
      resultOwnership: 'none',
    }, { timeout: timeoutMs });
    const v = r && r.result && r.result.value;
    return v && typeof v === 'object' ? v : null;
  }

  // A real click: the pointer is moved over the element and pressed, so the
  // page sees a trusted pointer event at that point rather than a script's
  // synthetic one. That matters for menus, canvas and anything that checks.
  async function click(selector, { pageId = null } = {}) {
    const id = pageId || (await current()).id;
    const at = await locate(selector, id);
    if (!at) throw new BidiError('Nothing on the page matches ' + clip(selector, 60) + '.', { kind: 'page' });
    const x = Math.round(at.x), y = Math.round(at.y);
    await conn().send('input.performActions', {
      context: id,
      actions: [{
        type: 'pointer', id: 'mouse', parameters: { pointerType: 'mouse' },
        actions: [
          { type: 'pointerMove', x, y, duration: 0, origin: 'viewport' },
          { type: 'pointerDown', button: 0 },
          { type: 'pointerUp', button: 0 },
        ],
      }],
    }, { timeout: timeoutMs });
    return { id, x, y, label: clip(at.label, 80), selector: String(selector) };
  }

  // Typing goes through the page's own value setter and fires the events a
  // framework listens for. input.performActions would need one key event per
  // character, which is both slow and wrong for anything past ASCII.
  async function type(selector, text, { pageId = null, submit = false } = {}) {
    const id = pageId || (await current()).id;
    const expr = '(function (sel, value, submit) {'
      + ' const el = document.querySelector(sel); if (!el) return { ok: false, why: "missing" };'
      + ' el.focus();'
      + ' const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;'
      + ' const setter = Object.getOwnPropertyDescriptor(proto, "value");'
      + ' if (setter && setter.set) setter.set.call(el, value); else el.value = value;'
      + ' el.dispatchEvent(new Event("input", { bubbles: true }));'
      + ' el.dispatchEvent(new Event("change", { bubbles: true }));'
      + ' if (submit) { const f = el.form; if (f && f.requestSubmit) f.requestSubmit(); else if (f) f.submit(); }'
      + ' return { ok: true }; })('
      + JSON.stringify(String(selector || '')) + ',' + JSON.stringify(String(text == null ? '' : text)) + ',' + (submit ? 'true' : 'false') + ')';
    const r = await conn().send('script.evaluate', { expression: expr, target: { context: id }, awaitPromise: false, resultOwnership: 'none' }, { timeout: timeoutMs });
    const v = r && r.result && r.result.value;
    if (!v || v.ok !== true) throw new BidiError('Nothing on the page matches ' + clip(selector, 60) + '.', { kind: 'page' });
    return { id, selector: String(selector), submit: Boolean(submit), selectorLabel: clip(text, 60) };
  }

  // A named key, for the few things a page only does from the keyboard.
  async function press(key, { pageId = null } = {}) {
    const id = pageId || (await current()).id;
    const named = String(key || '').trim();
    if (!named) throw new BidiError('No key to press.', { kind: 'protocol' });
    await conn().send('input.performActions', {
      context: id,
      actions: [{
        type: 'key', id: 'kbd',
        actions: [{ type: 'keyDown', value: named }, { type: 'keyUp', value: named }],
      }],
    }, { timeout: timeoutMs });
    return { id, key: named };
  }

  async function screenshot({ pageId = null } = {}) {
    const id = pageId || (await current()).id;
    const r = await conn().send('browsingContext.captureScreenshot', { context: id }, { timeout: Math.max(timeoutMs, 20000) });
    return { id, dataUrl: r && r.data ? 'data:image/png;base64,' + r.data : '' };
  }

  // Worth trying? Answers without throwing, so a caller can decide whether to
  // offer browser control at all.
  async function status() {
    try {
      const p = await pages();
      return { available: true, pages: p.length, url, error: null };
    } catch (e) {
      return { available: false, pages: 0, url, error: adviceFor(e), kind: e && e.kind || 'offline' };
    }
  }

  // What the consent card should say about an action before it runs. Same shape
  // as hands/consent.js wants: a human label for the thing being touched.
  async function describe(action, args = {}) {
    const name = String(action || '');
    if (name === 'click') {
      const at = await locate(args.selector).catch(() => null);
      return { targetName: at ? at.label : clip(args.selector, 80), action: 'click' };
    }
    if (name === 'type') return { targetName: clip(args.selector, 80), action: 'type', submit: Boolean(args.submit) };
    if (name === 'press') return { action: 'press', keys: String(args.key || '') };
    if (name === 'navigate') return { action: 'open', targetName: clip(args.url, 80) };
    return { action: name };
  }

  return { pages, current, read, navigate, locate, click, type, press, screenshot, status, describe, close: () => c && c.close(), endpoint: url };
}

module.exports = { createZen, createClient, endpointFor, flatten, pickPage, adviceFor, BidiError, DEFAULT_PORT, TEXT_MAX, INTERNAL_URL };
