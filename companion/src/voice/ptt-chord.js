'use strict';
// The talk key as a bare modifier chord: hold Ctrl and Alt, speak, let go.
//
// Windows only registers hotkeys that end in a real key, so a chord of
// modifiers alone cannot go through globalShortcut. Instead the probe
// (companion/src/win/probe.ps1) polls the modifier keys and reports each
// change, and this tracker turns those reports into one "down" when the whole
// chord is held and one "up" when any part of it is released. Pure: no
// Electron, no timers, so it is tested on its own.
//
// AltGr: on many non-US layouts the AltGr key arrives as left Ctrl plus right
// Alt together. That pair alone is typing, not a talk key, so it never counts.
// Right Ctrl plus right Alt, or any Ctrl with left Alt, does.

const VK = { shift: 16, control: 17, alt: 18, lshift: 160, rshift: 161, lcontrol: 162, rcontrol: 163, lalt: 164, ralt: 165 };
// Every key the probe has to watch for a modifier chord. Nothing else is
// watched for it: an app shortcut such as Ctrl+Alt+T shows up here only as a
// chord held for a moment with nothing said, and the Companion drops that.
const MOD_VKS = [16, 17, 18, 160, 161, 162, 163, 164, 165];

const NAMES = { commandorcontrol: 'control', ctrl: 'control', control: 'control', alt: 'alt', option: 'alt', shift: 'shift' };

// 'Control+Alt' -> ['control', 'alt']; a chord with a real key, or fewer
// than two modifiers, is not a modifier chord -> null.
function modifierChord(accelerator) {
  const parts = String(accelerator || '').split('+').map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (parts.length < 2) return null;
  const mods = [];
  for (const p of parts) {
    const m = NAMES[p];
    if (!m) return null;
    if (!mods.includes(m)) mods.push(m);
  }
  return mods.length >= 2 ? mods : null;
}

// Tracks the physical keys and answers 'down' | 'up' | null per report.
function createChordTracker(mods) {
  const want = modifierChord(Array.isArray(mods) ? mods.join('+') : mods) || ['control', 'alt'];
  const down = new Set();
  let held = false;
  function has(name) {
    if (name === 'control') return down.has(VK.control) || down.has(VK.lcontrol) || down.has(VK.rcontrol);
    if (name === 'alt') return down.has(VK.alt) || down.has(VK.lalt) || down.has(VK.ralt);
    return down.has(VK.shift) || down.has(VK.lshift) || down.has(VK.rshift);
  }
  // Left Ctrl + right Alt with nothing else on those two sides: AltGr.
  function altGr() {
    return down.has(VK.lcontrol) && down.has(VK.ralt) && !down.has(VK.lalt) && !down.has(VK.rcontrol);
  }
  function chordDown() { return want.every(has) && !(want.includes('control') && want.includes('alt') && altGr()); }
  function onKey(vk, isDown) {
    vk = Number(vk);
    if (!MOD_VKS.includes(vk)) return null;
    if (isDown) down.add(vk); else down.delete(vk);
    const now = chordDown();
    if (now && !held) { held = true; return 'down'; }
    if (!now && held) { held = false; return 'up'; }
    return null;
  }
  function reset() { down.clear(); held = false; }
  return { onKey, reset, get held() { return held; }, mods: want.slice() };
}

module.exports = { VK, MOD_VKS, modifierChord, createChordTracker };
