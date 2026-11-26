// Picks the look, before the first paint.
//
// Loaded in <head> by all three windows. It reads the theme from the settings
// the main process already sends to the page, or from a localStorage copy it
// wrote last time, and sets data-theme on <html>. Setting it here rather than
// after load is the whole point: a theme applied late is a visible flash of the
// other one.
//
// Shared by the renderer, the overlay and the dashboard, so the two themes are
// one decision in three windows rather than three half-decisions.
(function (root) {
  'use strict';

  const KEY = 'jarvisTheme';
  const THEMES = ['jarvis', 'nus'];
  const DEFAULT = 'jarvis';

  // Only a string counts: a corrupt preference (an array, a number) must not
  // read as a theme, it must fall back.
  const isTheme = (v) => typeof v === 'string' && THEMES.indexOf(v.trim().toLowerCase()) >= 0;
  const normalise = (v) => (isTheme(v) ? v.trim().toLowerCase() : DEFAULT);

  // The copy on this device, written whenever a theme is applied.
  function remembered(storage) {
    try {
      const v = (storage || root.localStorage).getItem(KEY);
      return isTheme(v) ? String(v).toLowerCase() : null;
    } catch { return null; }
  }

  function remember(theme, storage) {
    try { (storage || root.localStorage).setItem(KEY, normalise(theme)); } catch { /* private mode, quota */ }
  }

  // What the page should show right now: the saved setting, else what this
  // window showed last time, else the butler.
  function choose(settings = {}, storage) {
    if (settings && isTheme(settings.theme)) return normalise(settings.theme);
    const r = remembered(storage);
    return r || DEFAULT;
  }

  // Apply it. Returns the theme that is now in force.
  function apply(theme, { doc, storage } = {}) {
    const d = doc || root.document;
    const t = normalise(theme);
    if (!d || !d.documentElement) return t;
    d.documentElement.setAttribute('data-theme', t);
    d.documentElement.removeAttribute('data-theme-pending');
    remember(t, storage);
    return t;
  }

  // The other theme, for a keystroke or a single button that flips between them.
  const other = (theme) => (normalise(theme) === 'jarvis' ? 'nus' : 'jarvis');

  const api = { THEMES, DEFAULT, KEY, choose, normalise, isTheme, other, apply, remember, remembered };

  // Self-start: the page that included this file wanted the theme set now.
  if (root.document) {
    try { apply(remembered()); } catch { /* a page with no document still gets the api */ }
  }
  root.JarvisTheme = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
