// The invisible window over the overlay's controls (companion/src/touch-pad.js):
// nothing to see, every press handed on as it happens.
(function () {
  let down = null;
  const send = (type, e) => window.touchPad.send({ type, x: e.clientX, y: e.clientY, id: e.pointerId, kind: e.pointerType, button: e.button });
  window.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    down = e.pointerId;
    try { document.documentElement.setPointerCapture(e.pointerId); } catch (_) { /* gone already */ }
    send('down', e);
  });
  window.addEventListener('pointermove', (e) => { if (e.pointerId === down) send('move', e); });
  window.addEventListener('pointerup', (e) => { if (e.pointerId === down) { down = null; send('up', e); } });
  window.addEventListener('pointercancel', (e) => { if (e.pointerId === down) { down = null; send('cancel', e); } });
  window.addEventListener('contextmenu', (e) => { e.preventDefault(); window.touchPad.send({ type: 'menu', x: e.clientX, y: e.clientY, id: down || 1, kind: e.pointerType || 'touch', button: 2 }); });
})();
