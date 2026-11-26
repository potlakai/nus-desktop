// Surfaces by the Knot: how they open and close.
//
// The bubble, the composer, the hint and the keep chip are projected: the
// frame opens out of a point (the thread's tip) with a small overshoot, the
// text fades in after it, and closing is the reverse, fast and plain. They run
// on the Web Animations API so a reveal that is interrupted turns round from
// where it is instead of snapping. Timings and curves come from knot-spec.js.
//
// The sheet, the daily line and the scrims keep the class-based animation.
//
// The terminal hidden state is still a class (`hidden`, or `collapsed` for
// the sheet) so every CSS rule and test that keys on it keeps working. "Is it
// showing" is isShown(), never a class check, because an element on its way
// out still has the hidden class removed.
(() => {
  'use strict';
  const spec = window.NusKnotSpec || null;
  const T = spec ? spec.surfaces : { open: .32, close: .13, textIn: .18, textOut: .09, openBezier: [.22, 1.12, .36, 1], closeBezier: [.4, 0, 1, 1] };
  const A = spec ? spec.inline.surface : { openFrom: .05, closeTo: .93, textRise: 3 };
  const bez = (v) => 'cubic-bezier(' + v.join(',') + ')';
  const PROJECTED = new Set(['guide-bubble', 'quick-ask', 'knot-hint', 'keep-chip']);
  const LEAVE_MS = Math.round(T.close * 1000);
  const reduced = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const projected = (el) => PROJECTED.has(el.id) && typeof el.animate === 'function';

  function clearAnims(el) {
    for (const a of el._anims || []) { try { a.cancel(); } catch (_) { /* already gone */ } }
    el._anims = [];
  }
  // Where the element is right now, mid-animation or not.
  function current(el) {
    const cs = getComputedStyle(el);
    return { opacity: cs.opacity, transform: cs.transform && cs.transform !== 'none' ? cs.transform : 'scale(1)' };
  }
  function setOrigin(el, origin) {
    const o = typeof origin === 'function' ? origin() : origin;
    if (o && Number.isFinite(o.x) && Number.isFinite(o.y)) el.style.transformOrigin = o.x + 'px ' + o.y + 'px';
  }
  // Open: the frame scales out of its origin, then the text comes in.
  function reveal(el, opts = {}, from) {
    clearAnims(el);
    setOrigin(el, opts.origin);
    const open = el.animate([from || { opacity: 0, transform: 'scale(' + A.openFrom + ')' }, { opacity: 1, transform: 'scale(1)' }],
      { duration: T.open * 1000, easing: bez(T.openBezier), fill: 'both' });
    el._anims.push(open);
    // Let go of the element once it has arrived, so it is plain DOM while it sits there.
    open.onfinish = () => { try { open.cancel(); } catch (_) { /* fine */ } };
    if (opts.speak) for (const child of el.children) {
      const a = child.animate([{ opacity: 0, transform: 'translateY(' + A.textRise + 'px)' }, { opacity: 1, transform: 'none' }],
        { duration: T.textIn * 1000, delay: T.open * 1000, easing: 'cubic-bezier(.2,0,.2,1)', fill: 'backwards' });
      el._anims.push(a);
    }
  }

  function showSurface(el, place, hiddenClass = 'hidden', opts = {}) {
    if (!el) return;
    if (el._leaveTimer) { clearTimeout(el._leaveTimer); el._leaveTimer = null; }
    const proj = projected(el) && !opts.plain;
    const leaving = el.classList.contains('is-leaving');
    const from = proj && leaving ? current(el) : null;
    el.classList.remove('is-leaving');
    const wasHidden = el.classList.contains(hiddenClass);
    el.classList.remove(hiddenClass);
    if (typeof place === 'function') place();
    if (opts.plain || reduced()) { clearAnims(el); return; }
    if (proj) {
      if (wasHidden || leaving) reveal(el, opts, from);
      return;
    }
    if (wasHidden) {
      el.classList.remove('is-entering');
      void el.offsetWidth; // restart the enter animation
      el.classList.add('is-entering');
      const done = () => el.classList.remove('is-entering');
      el.addEventListener('animationend', done, { once: true });
      setTimeout(done, 600);
    }
  }

  function hideSurface(el, done, hiddenClass = 'hidden', opts = {}) {
    if (!el) { if (done) done(); return; }
    if (el.classList.contains(hiddenClass)) { if (done) done(); return; }
    if (el._leaveTimer) { clearTimeout(el._leaveTimer); el._leaveTimer = null; }
    el.classList.remove('is-entering');
    const finish = () => {
      el._leaveTimer = null;
      clearAnims(el);
      el.classList.add(hiddenClass);
      el.classList.remove('is-leaving');
      // Inline placement left by a layout pass never survives a hide.
      el.style.cssText = '';
      if (done) done();
    };
    if (opts.plain || reduced()) { finish(); return; }
    el.classList.add('is-leaving');
    if (!projected(el)) { el._leaveTimer = setTimeout(finish, LEAVE_MS); return; }
    // Close is the reverse: the text goes first, then the frame folds back.
    const from = current(el);
    clearAnims(el);
    const textOut = opts.speak ? T.textOut * 1000 : 0;
    if (textOut) for (const child of el.children) {
      el._anims.push(child.animate([{ opacity: 1 }, { opacity: 0 }], { duration: textOut, easing: 'ease-out', fill: 'forwards' }));
    }
    el._anims.push(el.animate([from, { opacity: 0, transform: 'scale(' + A.closeTo + ')' }],
      { duration: T.close * 1000, delay: textOut, easing: bez(T.closeBezier), fill: 'both' }));
    el._leaveTimer = setTimeout(finish, textOut + T.close * 1000);
  }

  const isShown = (el, hiddenClass = 'hidden') => !!el && !el.classList.contains(hiddenClass) && !el.classList.contains('is-leaving');
  // How long a hide takes for this element, for callers that sequence after it.
  const leaveMs = (el, speak) => (!el || reduced() ? 0 : Math.round((projected(el) && speak ? T.textOut * 1000 : 0) + T.close * 1000));

  window.NusSurface = { showSurface, hideSurface, isShown, reveal, leaveMs, LEAVE_MS };
})();
