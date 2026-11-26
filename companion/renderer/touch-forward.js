// What the touch pad caught (companion/src/touch-pad.js), played into this page
// as the same pointer events and click the control would have had. Every handler
// here already works from those, so nothing else knows a finger came this way.
(function (root) {
  const TAP_PX = 10;
  const LONG_MS = 500;
  const TYPING = 'input, textarea, select, [contenteditable="true"]';

  // Where the overlay's controls are, in window DIPs. The same list as overUIAt.
  function rectsOf(doc, view, selector, zoom) {
    const out = [];
    for (const el of doc.querySelectorAll(selector)) {
      const st = view.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || st.pointerEvents === 'none') continue;
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out.push({ x: Math.floor(r.left * zoom), y: Math.floor(r.top * zoom), width: Math.ceil(r.width * zoom), height: Math.ceil(r.height * zoom) });
    }
    return out;
  }

  function create({ doc, view, zoom, now = () => Date.now() }) {
    let press = null;
    const fire = (Kind, type, at, target, extra) => target.dispatchEvent(new Kind(type, Object.assign({ bubbles: true, cancelable: true, composed: true, view, clientX: at.x, clientY: at.y }, extra || {})));
    const pointer = (type, at, buttons) => fire(view.PointerEvent, type, at, press.target, { pointerId: press.id, pointerType: press.kind, isPrimary: true, button: press.button, buttons });

    // -> 'tap' when this ended a tap.
    function handle(ev) {
      const z = zoom();
      const at = { x: ev.x / z, y: ev.y / z };
      if (ev.type === 'down') {
        const target = doc.elementFromPoint(at.x, at.y);
        press = target ? { target, id: ev.id, kind: ev.kind, button: ev.button, from: at, moved: false, menu: false, at: now() } : null;
        if (press) pointer('pointerdown', at, ev.button === 2 ? 2 : 1);
        return null;
      }
      if (ev.type === 'menu') {
        const target = press ? press.target : doc.elementFromPoint(at.x, at.y);
        if (press) press.menu = true;
        if (target) fire(view.MouseEvent, 'contextmenu', at, target, { button: 2 });
        return null;
      }
      if (!press) return null;
      if (ev.type === 'move') {
        if (Math.hypot(at.x - press.from.x, at.y - press.from.y) > TAP_PX) press.moved = true;
        pointer('pointermove', at, 1);
        return null;
      }
      const p = press;
      if (ev.type === 'cancel') { pointer('pointercancel', at, 0); press = null; return null; }
      pointer('pointerup', at, 0);
      press = null;
      if (p.moved || p.menu || p.button !== 0 || now() - p.at >= LONG_MS) return null;
      const typing = p.target.closest && p.target.closest(TYPING);
      if (typing && typing.focus) typing.focus();
      fire(view.MouseEvent, 'click', at, p.target, { detail: 1, button: 0 });
      return 'tap';
    }
    return { handle };
  }

  root.NusTouchForward = { create, rectsOf };
})(typeof window !== 'undefined' ? window : globalThis);
