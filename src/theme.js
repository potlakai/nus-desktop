'use strict';
// What the look is, and what "switch it" means.
//
// One setting, two values, stored as a plain preference: 'jarvis' or 'nus'.
// Everything else — the palette, the attribute on <html>, the memory in
// localStorage — is downstream of that single string.
//
// Kept out of both main processes because it is needed in three windows and in
// the companion, and a rule in one place cannot drift from itself.

const THEMES = ['jarvis', 'nus'];
const DEFAULT = 'jarvis';

// Shown in Settings. Deliberately descriptive, not poetic: a switch labelled
// "mood" tells you nothing about what will happen when you move it.
const LABELS = {
  jarvis: { name: 'J.A.R.V.I.S', note: 'Gold on deep blue-black. The default.' },
  nus: { name: 'Nūs', note: 'The original: cool violet on near-black.' },
};

const isTheme = (value) => typeof value === 'string' && THEMES.includes(value.trim().toLowerCase());

// Anything unrecognised becomes the default rather than an error: a bad value
// in a preference file must not leave a window with no colours at all.
//
// Only a string counts. Coercing would let a corrupt preference such as
// ["nus"] or 1 read as a theme, and a window should not take its colours from
// something it had to guess at.
function normalise(value) {
  if (typeof value !== 'string') return DEFAULT;
  const v = value.trim().toLowerCase();
  return THEMES.includes(v) ? v : DEFAULT;
}

// The other one, for a keystroke or a single button that flips between them.
function other(theme) {
  return normalise(theme) === 'jarvis' ? 'nus' : 'jarvis';
}

function describe(theme) {
  const t = normalise(theme);
  return LABELS[t];
}

module.exports = { THEMES, DEFAULT, LABELS, isTheme, normalise, other, describe };
