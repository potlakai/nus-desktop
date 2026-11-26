// The dashboard's home view: the pill's words and the task list, live, in the
// window you can leave open. It holds no state of its own: tasks come from the
// same events the pill reads, words and buttons from the task panel's own logic
// (renderer/task-panel.js), switches from one list (renderer/quick-options.js),
// and every button goes out as the action the pill's card sends.
//
// Everything a task says goes in through textContent, never as markup: a task's
// words can quote a web page or a window title.
//
// The small logic is plain functions so the tests run it in Node.
(function (root) {
  'use strict';

  const ASKS = 5;

  // "4 min", "1 h", "Today", or the date. Rounded down, never in the future.
  function ago(at, now) {
    const t = typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(t)) return '';
    const min = Math.max(0, Math.floor((now - t) / 60000));
    if (min < 1) return 'Now';
    if (min < 60) return min + ' min';
    if (min < 6 * 60) return Math.floor(min / 60) + ' h';
    const a = new Date(t), b = new Date(now);
    return a.toDateString() === b.toDateString() ? 'Today' : a.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  // The newest few conversations from Saved, as a line and an age.
  function askRows(sessions, now) {
    return (sessions || []).map((s) => ({ id: s.id, text: String(s.title || s.first_line || '').trim(), at: s.started_at }))
      .filter((r) => r.text)
      .sort((a, b) => (String(a.at) < String(b.at) ? 1 : String(a.at) > String(b.at) ? -1 : 0))
      .slice(0, ASKS)
      .map((r) => ({ id: r.id, text: r.text, when: ago(r.at, now) }));
  }

  function projectLine(p) { return p.nextStep ? 'Next: ' + p.nextStep : p.lastStep ? 'Last: ' + p.lastStep : 'Pick it up where it stopped.'; }

  // The state word as a person reads it when nothing is going on.
  function wordOf(k) { return (k && k.word) || 'Ready'; }

  // ---- the DOM -------------------------------------------------------------
  function create({ doc, api, panel, options, knot, clock, openSaved, openSession, openSettings, onError }) {
    const $ = (s) => doc.querySelector(s);
    const now = typeof clock === 'function' ? clock : () => Date.now();
    const fail = (e) => { if (onError) onError(e); };
    const tasks = new Map();
    const state = { enabled: false, name: '', settings: null, voice: null, forced: false, accel: '', knot: null, projects: [], asks: [], showKnot: false };

    function make(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }
    function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

    // ---- the strip ---------------------------------------------------------
    function paintStrip() {
      const v = panel.panelView([...tasks.values()], { now: now(), expanded: true });
      $('#d-greet').textContent = panel.greeting(new Date(now()).getHours(), state.name);
      $('#d-count').textContent = state.enabled ? v.count : 'Nothing running';
      const key = $('#d-key');
      clear(key);
      key.appendChild(make('span', '', 'Hold'));
      panel.keyLabel(state.accel).split(' + ').forEach((k, i) => { if (i) key.appendChild(make('span', '', '+')); key.appendChild(make('kbd', '', k)); });
      key.appendChild(make('span', '', 'to talk'));
      $('#d-show-knot').hidden = !state.showKnot;
    }

    // The same object as the pill on the screen: its word, line, bar and accent.
    function paintPill() {
      const k = state.knot || {};
      const pill = $('#d-pill');
      pill.dataset.state = k.tone || 'idle';
      if (k.accent) pill.style.setProperty('--isl-acc', k.accent); else pill.style.removeProperty('--isl-acc');
      $('#d-word').textContent = wordOf(k);
      const step = $('#d-step');
      step.textContent = k.step || '';
      step.hidden = !k.step;
      $('#d-esc').hidden = !k.esc;
      const bar = $('#d-bar');
      bar.hidden = k.bar == null;
      if (k.bar != null) bar.firstElementChild.style.width = Math.round(k.bar * 100) + '%';
    }

    // ---- now ---------------------------------------------------------------
    // A card that has not changed keeps its node, and a new step only changes its
    // line. A rebuild between a press and its release would lose the click, and the
    // first click on this window always brings a refresh with it.
    const cardNodes = new Map();
    function buttons(t) {
      const row = make('div', 'd-acts');
      for (const a of panel.actionsFor(t)) {
        const b = make('button', a.primary ? 'd-btn primary' : 'd-btn', a.label);
        b.type = 'button';
        b.addEventListener('click', () => {
          b.disabled = true;
          Promise.resolve(api.taskAction({ action: a.action, taskId: a.taskId })).catch(fail).then(() => { b.disabled = false; });
        });
        row.appendChild(b);
      }
      return row;
    }
    // What makes a card a different card: not its line or how far along its bar is.
    function cardShape(t) { return JSON.stringify([t.state, panel.cardTitle(t), panel.actionsFor(t).map((a) => [a.action, a.label, a.primary]), panel.progressOf(t) != null]); }
    function card(t) {
      const c = make('div', 'd-card');
      c.dataset.state = t.state;
      c.dataset.id = t.id;
      if (t.state === 'needs_input') c.classList.add('needs');
      const head = make('div', 'd-row');
      head.appendChild(make('b', 'd-title', panel.cardTitle(t)));
      head.appendChild(make('span', 'd-chip', panel.wordFor(t.state)));
      c.appendChild(head);
      const line = make('div', 'd-line', panel.cardLine(t));
      c.appendChild(line);
      let fill = null;
      if (panel.progressOf(t) != null) { const bar = make('div', 'd-bar'); fill = make('i'); bar.appendChild(fill); c.appendChild(bar); }
      if (panel.actionsFor(t).length) c.appendChild(buttons(t));
      return { node: c, line, fill, shape: cardShape(t) };
    }
    function say(box, key, build) {
      if (box.dataset.mode === key) return;
      clear(box);
      cardNodes.clear();
      box.dataset.mode = key;
      box.appendChild(build());
    }
    function paintNow() {
      const box = $('#d-now');
      if (!state.enabled) {
        say(box, 'off', () => {
          const off = make('div', 'd-empty');
          off.appendChild(make('strong', '', 'The task list is off.'));
          off.appendChild(make('p', '', 'Turn it on and what Hands is doing shows here and on the pill, with a Stop.'));
          const on = make('button', 'd-btn primary', 'Turn on the task list');
          on.type = 'button';
          on.addEventListener('click', () => { on.disabled = true; Promise.resolve(api.settingsSet({ tasks: true })).catch(fail).then(() => { on.disabled = false; }); });
          off.appendChild(on);
          return off;
        });
        return;
      }
      const v = panel.panelView([...tasks.values()], { now: now(), expanded: true });
      if (!v.cards.length) {
        // A Mac has no Hands (Windows only): no offer to turn it on, no Notepad example.
        const line = typeof window !== 'undefined' && window.NusMacWords && window.NusMacWords.mac
          ? 'Hold ' + panel.keyLabel(state.accel) + ', ask something, and let go.'
          : state.settings && state.settings.hands === true
          ? 'Hold ' + panel.keyLabel(state.accel) + ' and ask for something, like "open Notepad and write my to-do list".'
          : 'Hold ' + panel.keyLabel(state.accel) + ' and ask something. Turn Hands on below and it can click and type for you too.';
        say(box, 'empty:' + line, () => {
          const empty = make('div', 'd-empty');
          empty.appendChild(make('strong', '', 'Nothing running.'));
          empty.appendChild(make('p', '', line));
          return empty;
        });
        return;
      }
      if (box.dataset.mode !== 'cards') { clear(box); cardNodes.clear(); box.dataset.mode = 'cards'; }
      const keep = new Set(v.cards.map((t) => t.id));
      for (const [id, c] of cardNodes) if (!keep.has(id)) { box.removeChild(c.node); cardNodes.delete(id); }
      const order = v.cards.map((t) => {
        let c = cardNodes.get(t.id);
        if (c && c.shape !== cardShape(t)) { box.removeChild(c.node); c = null; }
        if (!c) { c = card(t); cardNodes.set(t.id, c); box.appendChild(c.node); }
        const text = panel.cardLine(t);
        if (c.line.textContent !== text) c.line.textContent = text;
        const k = panel.progressOf(t);
        if (c.fill && k != null) c.fill.style.width = Math.round(k * 100) + '%';
        return c.node;
      });
      // Only when the order really changed: moving a node drops a press on it.
      if (order.some((n, i) => box.children[i] !== n)) for (const n of order) box.appendChild(n);
    }

    // ---- projects and asks -------------------------------------------------
    let shownProjects = null, shownAsks = null;
    function paintProjects() {
      const key = JSON.stringify([state.enabled, state.projects.map((p) => [p.id, p.name, projectLine(p)])]);
      if (key === shownProjects) return;
      shownProjects = key;
      const box = $('#d-projects');
      clear(box);
      if (!state.projects.length) {
        box.appendChild(make('div', 'd-empty', state.enabled ? 'Say "keep this as a project" during a task, and it comes back here with a Continue.' : 'Kept projects show here when the task list is on.'));
        return;
      }
      for (const p of state.projects) {
        const row = make('div', 'd-li');
        row.dataset.id = p.id;
        const m = make('div', 'm');
        m.appendChild(make('div', 'n', p.name));
        m.appendChild(make('div', 'w', projectLine(p)));
        row.appendChild(m);
        const go = make('button', 'd-btn', 'Continue');
        go.type = 'button';
        go.addEventListener('click', () => { Promise.resolve(api.projectContinue(p.id)).catch(fail); });
        row.appendChild(go);
        box.appendChild(row);
      }
    }
    function paintAsks() {
      const key = JSON.stringify(state.asks);
      if (key === shownAsks) return;
      shownAsks = key;
      const box = $('#d-asks');
      clear(box);
      if (!state.asks.length) { box.appendChild(make('div', 'd-empty', 'What you ask the Knot shows here.')); return; }
      for (const r of state.asks) {
        const row = make('button', 'd-li d-ask');
        row.type = 'button';
        row.appendChild(make('span', 'q', r.text));
        row.appendChild(make('span', 'ago', r.when));
        row.addEventListener('click', () => openSession(r.id));
        box.appendChild(row);
      }
    }

    // ---- the quick row -----------------------------------------------------
    function voiceOn() { return state.voice ? state.voice.voice !== 'system' : options.isOn(options.SWITCHES.find((o) => o.id === 'voice'), state.settings); }
    function setTog(btn, on) { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); }
    function buildQuick() {
      const box = $('#d-quick');
      clear(box);
      const seg = make('div', 'd-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Where the Knot lives');
      for (const c of options.HOME.choices) {
        const b = make('button', '', c.label);
        b.type = 'button';
        b.dataset.island = String(c.value);
        b.addEventListener('click', () => { Promise.resolve(api.settingsSet(options.homePatch(c.value))).catch(fail); });
        seg.appendChild(b);
      }
      box.appendChild(seg);
      for (const o of options.switchesFor('dashboard')) {
        const b = make('button', 'd-tog');
        b.type = 'button';
        b.dataset.option = o.id;
        b.appendChild(make('span', '', o.label));
        b.appendChild(make('u'));
        b.addEventListener('click', () => flip(o));
        box.appendChild(b);
      }
      const more = make('button', 'd-more', 'Settings');
      more.type = 'button';
      more.addEventListener('click', () => openSettings());
      box.appendChild(more);
    }
    function flip(o) {
      const s = state.settings || {};
      if (o.id === 'voice') {
        // Not installed: Settings, where the download and its progress live.
        if (!voiceOn() && state.voice && !state.voice.installed) { openSettings('voice'); return; }
        Promise.resolve(api.settingsSet(options.patchFor(o, !voiceOn()))).then(() => api.voiceStatus()).then((v) => { state.voice = v; paintQuick(); }).catch(fail);
        return;
      }
      Promise.resolve(api.settingsSet(options.patchFor(o, !options.isOn(o, s)))).catch(fail);
    }
    function paintQuick() {
      const s = state.settings;
      if (!s) return;
      const box = $('#d-quick');
      if (!box.firstChild) buildQuick();
      const island = options.isIsland(s);
      for (const b of box.querySelectorAll('.d-seg button')) { const on = (b.dataset.island === 'true') === island; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
      for (const o of options.switchesFor('dashboard')) {
        const b = box.querySelector('[data-option="' + o.id + '"]');
        if (!b) continue;
        setTog(b, o.id === 'voice' ? voiceOn() : options.isOn(o, s));
        if (o.id === 'hide') b.disabled = !!state.forced;
      }
    }

    function paint() { paintStrip(); paintPill(); paintNow(); paintProjects(); paintAsks(); paintQuick(); }

    // ---- what comes in -----------------------------------------------------
    async function refreshTasks() {
      const r = await api.tasksList();
      tasks.clear();
      for (const t of r.tasks || []) if (t && t.id) tasks.set(t.id, t);
      state.enabled = r.enabled !== false;
      state.name = r.name || '';
      state.projects = r.projects || [];
    }
    // Everything once: opening the view, or the window coming back to the front.
    async function refresh() {
      const [settings, status, voice, word, sessions] = await Promise.all([api.settingsGet(), api.status(), api.voiceStatus(), api.knotWord(), api.sessions(), refreshTasks()]);
      state.settings = settings;
      state.voice = voice;
      state.knot = word;
      state.forced = !!status.captureForcedOff;
      state.accel = status.ptt && status.ptt.accelerator;
      state.showKnot = !status.visible;
      state.asks = askRows(sessions, now());
      paint();
    }
    // One tasks:event, as the pill gets it. Anything but a step can change a
    // project, so those read the list again, a little later and only once.
    let projectTimer = null;
    function onTask(p) {
      if (!p) return;
      if (p.type === 'esc') return;
      if (p.type === 'sync') {
        tasks.clear();
        for (const t of p.tasks || []) if (t && t.id) tasks.set(t.id, t);
        state.enabled = p.enabled !== false;
        if (p.name != null) state.name = String(p.name);
      } else if (p.task && p.task.id) {
        state.enabled = true;
        tasks.set(p.task.id, p.task);
      }
      paintStrip(); paintNow();
      if (p.type === 'step') return;
      clearTimeout(projectTimer);
      projectTimer = setTimeout(() => { Promise.resolve(api.tasksList()).then((r) => { state.projects = r.projects || []; paintProjects(); }).catch(fail); }, 400);
    }
    function onSettings(s) { state.settings = s; paintQuick(); paintNow(); if (typeof s.tasks === 'boolean') refreshTasks().then(() => { paintStrip(); paintNow(); paintProjects(); }).catch(fail); }
    function onVoice(v) { state.voice = v; paintQuick(); }
    function onKnot(w) { state.knot = w; paintPill(); }
    function onStatus(s) { if (s && s.ptt) state.accel = s.ptt.accelerator; if (s && 'visible' in s) state.showKnot = !s.visible; paintStrip(); }

    if (knot) knot(); // the small Knot in the strip
    const pill = $('#d-pill');
    pill.addEventListener('click', () => { const first = $('#d-now .d-card'); if (first) first.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); });
    $('#d-all-asks').addEventListener('click', () => openSaved());
    $('#d-show-knot').addEventListener('click', () => { Promise.resolve(api.control('show')).catch(fail); });

    return { refresh, onTask, onSettings, onVoice, onKnot, onStatus, get tasks() { return [...tasks.values()]; } };
  }

  const api = { ago, askRows, projectLine, wordOf, create, ASKS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NusDashHome = api;
})(typeof window !== 'undefined' ? window : globalThis);
