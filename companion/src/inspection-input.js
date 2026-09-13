'use strict';

const INSPECT_SHORTCUT = 'CommandOrControl+Shift+T';

function registerInspectionShortcut(shortcuts, handler) {
  try {
    const ok = shortcuts.isRegistered(INSPECT_SHORTCUT) || shortcuts.register(INSPECT_SHORTCUT, handler);
    return { accelerator: INSPECT_SHORTCUT, ok: !!ok, error: ok ? null : 'Ctrl+Shift+T is in use by another app or another Nūs build. Quit the other copy, then reopen Companion settings to retry.' };
  } catch (_) {
    return { accelerator: INSPECT_SHORTCUT, ok: false, error: 'Windows could not register Ctrl+Shift+T. Reopen Companion settings to retry.' };
  }
}

function usableHit(hit, bounds) {
  const r = hit && hit.bbox;
  return !!r && [r.x, r.y, r.w, r.h].every(Number.isFinite) && r.w >= 4 && r.h >= 4 && r.x >= 0 && r.y >= 0 && r.x + r.w <= bounds.width && r.y + r.h <= bounds.height && r.w * r.h <= 0.25 * bounds.width * bounds.height;
}

async function resolveInspectionHit({ point, bounds, lookup, signal, sleep = ms => new Promise(r => setTimeout(r, ms)) }) {
  // Chromium can expose only its native frame on the first accessibility
  // query. Retry once at the ORIGINAL hotkey position, never a moved cursor.
  const originalPoint = { x: point.x, y: point.y };
  for (let attempt = 0; attempt < 2; attempt++) {
    if (signal?.aborted) return null;
    const hit = await lookup({ ...originalPoint });
    if (signal?.aborted) return null;
    // A protected field is not an accessibility miss: never turn it into an
    // automatic surrounding-area screenshot on the retry/fallback path.
    if (hit?.blocked) return hit;
    if (usableHit(hit, bounds)) return hit;
    if (attempt === 0) await sleep(500);
  }
  return null;
}

function pointContext(point, bounds) {
  if (!point || !bounds || ![point.x, point.y, bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) throw new Error('The pointed display is unavailable.');
  const x = point.x - bounds.x, y = point.y - bounds.y;
  if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height || bounds.width < 16 || bounds.height < 16) throw new Error('Point within the display where the Knot lives, then try again.');
  // Deliberately bounded nearby context, never the entire desktop. Near an
  // edge shift the crop inward but keep the strand at the original point.
  const w = Math.min(480, bounds.width / 2), h = Math.min(320, bounds.height / 2);
  const bbox = { x: Math.max(0, Math.min(x - w / 2, bounds.width - w)), y: Math.max(0, Math.min(y - h / 2, bounds.height - h)), w, h };
  const marker = { x: Math.max(0, Math.min(x - 4, bounds.width - 8)), y: Math.max(0, Math.min(y - 4, bounds.height - 8)), w: 8, h: 8 };
  return { bbox, marker, point: { x, y } };
}

module.exports = { INSPECT_SHORTCUT, registerInspectionShortcut, resolveInspectionHit, usableHit, pointContext };
