// The options menu: from a click on the free Knot, or a right click or long press
// on the pill. Rows come from the one list the dashboard's row also reads
// (quick-options.js). Every switch writes through the settings door the overlay
// already has; main sends the result to both windows.
//
// Where it sits is the host's business (place), because that depends on the pill
// and the Knot. It stays open through a switch, so going back is one more tap.
(function (root) {
  'use strict';

  const LEAVE_MS = 6000;   // the pointer gone this long, and it folds

  // canPlay (optional): true when the Knot is free to play right now. The
  // "Shoot hoops" row (renderer/play.js) shows only then, never mid-task.
  function create({ doc, options, read, write, action, place, onChange, setTimer, clearTimer, canPlay }) {
    const later = setTimer || ((fn, ms) => setTimeout(fn, ms));
    const cancel = clearTimer || ((t) => clearTimeout(t));
    const state = { open: false, source: 'knot', settings: null, leave: null };
    const el = doc.createElement('div');
    el.id = 'knot-menu';
    el.hidden = true;
    el.tabIndex = -1;
    el.setAttribute('role', 'menu');
    el.setAttribute('aria-label', 'Options');

    function make(tag, cls, text) { const n = doc.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = String(text); return n; }

    function paint() {
      const s = state.settings || {};
      el.textContent = '';
      const seg = make('div', 'm-seg');
      seg.setAttribute('role', 'group');
      seg.setAttribute('aria-label', 'Where the Knot lives');
      const island = options.isIsland(s);
      for (const c of options.HOME.choices) {
        const on = c.value === island;
        const b = make('button', on ? 'on' : '', c.label);
        b.type = 'button';
        b.dataset.island = String(c.value);
        b.setAttribute('aria-pressed', String(on));
        b.addEventListener('click', () => { if (!on) change(options.homePatch(c.value)); });
        seg.appendChild(b);
      }
      el.appendChild(seg);
      for (const o of options.switchesFor('menu')) {
        const on = options.isOn(o, s);
        const row = make('button', on ? 'm-row on' : 'm-row');
        row.type = 'button';
        row.dataset.option = o.id;
        row.setAttribute('role', 'menuitemcheckbox');
        row.setAttribute('aria-checked', String(on));
        row.appendChild(make('span', '', o.label));
        row.appendChild(make('u'));
        row.addEventListener('click', () => change(options.patchFor(o, !options.isOn(o, state.settings || {}))));
        el.appendChild(row);
      }
      if (canPlay && canPlay()) {
        const row = make('button', 'm-row', 'Shoot hoops');
        row.type = 'button';
        row.dataset.action = 'play';
        row.setAttribute('role', 'menuitem');
        row.addEventListener('click', () => { close(); action('play'); });
        el.appendChild(row);
      }
      el.appendChild(make('div', 'm-sep'));
      for (const [id, label, dim] of [['menu-dashboard', 'Open the dashboard', false], ['menu-quit', 'Quit Nūs', true]]) {
        const row = make('button', dim ? 'm-row m-dim' : 'm-row', label);
        row.type = 'button';
        row.dataset.action = id;
        row.setAttribute('role', 'menuitem');
        row.addEventListener('click', () => { close(); action(id); });
        el.appendChild(row);
      }
    }

    // The row flips at once; main's answer then says what is really so.
    function change(patch) {
      state.settings = Object.assign({}, state.settings, patch);
      paint();
      Promise.resolve(write(patch)).then((s) => { if (s && state.open) setSettings(s); }).catch(() => {});
    }
    function setSettings(s) { state.settings = s; if (state.open) { paint(); place(el, state.source); } }

    function armLeave() { disarmLeave(); state.leave = later(close, LEAVE_MS); }
    function disarmLeave() { if (state.leave) { cancel(state.leave); state.leave = null; } }
    el.addEventListener('pointerenter', disarmLeave);
    el.addEventListener('pointerleave', () => { if (state.open) armLeave(); });

    function show(source) {
      state.source = source === 'pill' ? 'pill' : 'knot';
      const first = !state.open;
      state.open = true;
      el.hidden = false;
      paint();
      place(el, state.source);
      armLeave();
      if (first && onChange) onChange(true);
      Promise.resolve(read()).then((s) => { if (s && state.open) setSettings(s); }).catch(() => {});
    }
    function close() {
      disarmLeave();
      if (!state.open) return;
      state.open = false;
      el.hidden = true;
      if (onChange) onChange(false);
    }

    return {
      el, show, close, setSettings,
      toggle(source) { if (state.open) close(); else show(source); },
      relayout() { if (state.open) place(el, state.source); },
      get open() { return state.open; },
      get source() { return state.source; },
    };
  }

  const api = { create, LEAVE_MS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NusKnotMenu = api;
})(typeof window !== 'undefined' ? window : globalThis);
