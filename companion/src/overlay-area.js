'use strict';
// The overlay's rectangle on a display: the work area. With an auto-hidden taskbar
// that is the whole display, and Windows will not reveal the taskbar while a
// topmost window covers the whole monitor (live 2026-11-03: only the Windows key
// brought it up). So in that case one pixel row stays uncovered at the bottom edge.
function overlayArea(display) {
  const w = display.workArea, b = display.bounds;
  const whole = b && w.x === b.x && w.y === b.y && w.width === b.width && w.height === b.height;
  return whole ? { x: w.x, y: w.y, width: w.width, height: w.height - 1 } : w;
}

module.exports = { overlayArea };
