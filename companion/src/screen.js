// Full-resolution screenshot via desktopCapturer (main process).
// First call triggers the macOS Screen-Recording permission prompt for the app.
const { desktopCapturer, screen } = require('electron');

async function captureScreenshot() {
  const primary = screen.getPrimaryDisplay();
  const { width, height } = primary.size;
  const scale = primary.scaleFactor || 1;
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.floor(width * scale), height: Math.floor(height * scale) }
  });
  if (!sources.length) return null;
  // Prefer the primary display source.
  const src = sources.find((s) => String(s.display_id) === String(primary.id)) || sources[0];
  const img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  return img.toDataURL(); // data:image/png;base64,...
}

// One display, downscaled for a pointing model: 1280px on the long side is
// plenty for "which control" and a fraction of the tokens of a 4K frame.
// Returns the capture plus what is needed to map normalized boxes back.
async function captureDisplay(displayId, opts = {}) {
  const { nativeImage } = require('electron');
  const maxSide = Number(opts.maxSide) || 1280;
  const displays = screen.getAllDisplays();
  const display = (displayId != null && displays.find((d) => d.id === displayId)) || screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const pxWidth = Math.floor(display.size.width * scale), pxHeight = Math.floor(display.size.height * scale);
  // opts.thumb: ask for the small picture directly instead of the whole screen
  // and shrinking it here. Assignment mode's change frames, three a second,
  // made the cursor stutter when each one was a full 2560 px grab (2026-09-21).
  const tf = opts.thumb ? Math.min(1, maxSide / Math.max(pxWidth, pxHeight)) : 1;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: Math.max(1, Math.round(pxWidth * tf)), height: Math.max(1, Math.round(pxHeight * tf)) } });
  if (!sources.length) return null;
  const src = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
  const syncStarted = performance.now();
  let img = src.thumbnail;
  if (!img || img.isEmpty()) return null;
  const size = img.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest > maxSide) {
    const f = maxSide / longest;
    img = img.resize({ width: Math.round(size.width * f), height: Math.round(size.height * f), quality: 'good' });
  }
  const out = img.getSize();
  const cap = {
    // opts.dataUrl === false: the caller only wants `image` (assignment mode's
    // change frames and JPEGs), so the PNG encode is skipped.
    dataUrl: nativeImage && opts.dataUrl !== false ? img.toDataURL() : null,
    width: out.width, height: out.height,
    pxWidth: size.width, pxHeight: size.height,
    display: { id: display.id, bounds: display.bounds, workArea: display.workArea, scaleFactor: scale },
    blockMs: performance.now() - syncStarted,
  };
  // Kept for the "did the click change anything" hash, so the PNG is not
  // decoded again. Not enumerable: it never travels with the capture.
  Object.defineProperty(cap, 'image', { value: img, enumerable: false });
  return cap;
}

module.exports = { captureScreenshot, captureDisplay };
