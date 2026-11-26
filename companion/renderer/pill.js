// What the pill says during a task, on top of the state word the island code
// works out: the current step, a thin bar when the steps are really known, Esc
// to stop, the needs-you ring, and a moment of Done when a task ends.
//
// It reads only what tasks:event already carries. The accent comes from the spec
// (character.island.accents) when the spec names one; with none named the CSS
// keeps its own, so no colour is written here.
//
// Plain functions, so the tests run it in Node.
(function (root) {
  'use strict';

  const LIVE = ['preparing', 'running', 'verifying'];
  const STEP_EVERY_MS = 600;    // the second line changes at most this often
  const FLASH_MS = 6000;        // Done or Did not work, then the pill goes back

  function panelApi() {
    if (typeof module !== 'undefined' && module.exports) return require('./task-panel.js');
    return root.NusTaskPanel;
  }

  function facts(tasks) {
    const all = tasks || [];
    return {
      running: all.find((t) => t && LIVE.includes(t.state)) || null,
      needs: all.find((t) => t && t.state === 'needs_input') || null,
      next: all.filter((t) => t && t.state === 'queued').length,
    };
  }

  // word and tone: what the island code worked out. Returns what the pill shows.
  // Your own key wins over everything; then a task that wants you; then a task at work.
  function dress({ word, tone, hands, tasks, flash, now }) {
    const P = panelApi(), h = hands || {}, f = facts(tasks);
    const count = f.next ? f.next + ' up next' : '';
    if (tone === 'listening') return { word, tone, step: '', bar: null, esc: false, count: '' };
    if (f.needs || h.waiting) {
      const own = !f.needs || f.needs.executor === 'hands';
      return { word: own ? 'Hands is waiting for you' : 'Waiting for you', tone: 'needs', step: f.needs ? P.cardTitle(f.needs) : '', bar: null, esc: false, count: '' };
    }
    if (h.active || f.running) {
      const t = f.running, own = !t || t.executor === 'hands';
      return { word: own ? 'Hands is working' : 'Working', tone: 'hands', step: t ? P.cardLine(t) : '', bar: t ? P.progressOf(t) : null, esc: !!h.active, count: '' };
    }
    if (flash && !(now >= flash.until)) return { word: flash.word, tone: flash.tone, step: flash.step || '', bar: null, esc: false, count };
    return { word, tone, step: '', bar: null, esc: false, count };
  }

  // The moment a task's end earns on the pill. null: nothing to say (a stop you asked for).
  function flashFor(event, now) {
    if (!event) return null;
    const t = event.task || {}, d = event.data || {};
    const until = (now || 0) + FLASH_MS;
    if (event.type === 'done') return { word: 'Done', tone: 'done', step: String(d.summary || t.summary || 'Finished.'), until };
    if (event.type === 'failed') { const P = panelApi(); return { word: 'Did not work', tone: 'error', step: P.cardLine(Object.assign({}, t, { state: 'failed' })), until }; }
    return null;
  }

  // Free Knot: the pill comes only for a task, and goes when it ends (O6 B).
  function wanted({ island, hands, tasks, flash, panelOpen, now }) {
    if (island || panelOpen) return true;
    const h = hands || {}, f = facts(tasks);
    if (h.active || f.running || f.needs) return true;
    return !!(flash && !(now >= flash.until));
  }

  // '#rrggbb' or '#rgb' to 'r,g,b', the form --isl-acc takes. Anything else: null.
  function rgbOf(hex) {
    const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    const h = m[1].length === 3 ? m[1].replace(/./g, (c) => c + c) : m[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).join(',');
  }
  function accentFor(spec, tone) {
    const accents = spec && spec.character && spec.character.island && spec.character.island.accents;
    return accents ? rgbOf(accents[tone]) : null;
  }

  // The second line, at most every STEP_EVERY_MS: the newest wins and none piles
  // up. Clearing is at once, so a word that has moved on never wears an old line.
  function stepper({ apply, now, setTimer, clearTimer }) {
    const clock = now || (() => Date.now());
    const later = setTimer || ((fn, ms) => setTimeout(fn, ms));
    const cancel = clearTimer || ((t) => clearTimeout(t));
    let shown = '', at = -Infinity, timer = null, waiting = null;
    function show(text) { shown = text; at = clock(); apply(text); }
    return {
      set(text) {
        text = String(text || '');
        if (text === shown && waiting == null) return;
        if (timer) { cancel(timer); timer = null; waiting = null; }
        if (text === shown) return;
        const left = at + STEP_EVERY_MS - clock();
        if (!text || left <= 0) { show(text); return; }
        waiting = text;
        timer = later(() => { timer = null; const t = waiting; waiting = null; show(t); }, left);
      },
      get shown() { return shown; },
    };
  }

  const api = { LIVE, STEP_EVERY_MS, FLASH_MS, facts, dress, flashFor, wanted, rgbOf, accentFor, stepper };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NusPill = api;
})(typeof window !== 'undefined' ? window : globalThis);
