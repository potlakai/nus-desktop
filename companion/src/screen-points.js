'use strict';
// Screen points (DIPs, what windows and the cursor use) to physical pixels (what the
// screenshot and the Windows probe use), and back.
//
// Electron's screen.dipToScreenPoint and screen.screenToDipPoint exist on Windows and
// Linux only. On a Mac they are undefined, so every ask that pointed threw
// "screen.dipToScreenPoint is not a function" and the Knot stayed on "Still working..."
// (the Mac lag walk, 2026-11-15). On a Mac the same mapping is worked out here from each
// display's bounds and scale factor: a display keeps its origin, and the distance from
// the origin is multiplied by the scale factor. That is the space the capture code
// already assumes (src/screen.js: pxWidth = size x scaleFactor, origin = the display's).

function createScreenPoints(screen, platform = process.platform) {
  if (platform !== 'darwin' && screen && typeof screen.dipToScreenPoint === 'function' && typeof screen.screenToDipPoint === 'function') {
    return { dipToScreen: (pt) => screen.dipToScreenPoint(pt), screenToDip: (pt) => screen.screenToDipPoint(pt) };
  }
  const displays = () => { try { return screen.getAllDisplays(); } catch (_) { return []; } };
  const scaleOf = (d) => (d && Number(d.scaleFactor) > 0 ? Number(d.scaleFactor) : 1);
  function nearestDip(pt) {
    try { if (typeof screen.getDisplayNearestPoint === 'function') return screen.getDisplayNearestPoint({ x: Math.round(pt.x), y: Math.round(pt.y) }); } catch (_) { /* fall through */ }
    const list = displays();
    return list.find((d) => pt.x >= d.bounds.x && pt.x < d.bounds.x + d.bounds.width && pt.y >= d.bounds.y && pt.y < d.bounds.y + d.bounds.height) || list[0] || null;
  }
  function dipToScreen(pt) {
    const d = nearestDip(pt);
    if (!d) return { x: Math.round(pt.x), y: Math.round(pt.y) };
    const s = scaleOf(d), b = d.bounds;
    return { x: Math.round(b.x + (pt.x - b.x) * s), y: Math.round(b.y + (pt.y - b.y) * s) };
  }
  function screenToDip(pt) {
    const list = displays();
    const inside = (d) => { const s = scaleOf(d), b = d.bounds; return pt.x >= b.x && pt.x < b.x + b.width * s && pt.y >= b.y && pt.y < b.y + b.height * s; };
    const d = list.find(inside) || nearestDip(pt);
    if (!d) return { x: Math.round(pt.x), y: Math.round(pt.y) };
    const s = scaleOf(d), b = d.bounds;
    return { x: Math.round(b.x + (pt.x - b.x) / s), y: Math.round(b.y + (pt.y - b.y) / s) };
  }
  return { dipToScreen, screenToDip };
}

module.exports = { createScreenPoints };
