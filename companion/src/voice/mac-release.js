'use strict';
// The talk key's release on a Mac (a tester's round 3, 2026-11-16: holding Control+Option+Space
// listened, but letting go did not send; the bubble said "Release to send").
//
// A Mac has no probe, and a global key-up watcher would need a native module plus the Input
// Monitoring permission. The modifier state does not: +[NSEvent modifierFlags] answers which
// modifiers are down right now, for the whole system, with no permission. So while the key is
// held, a small JXA loop in the built-in osascript polls it every 30 ms and prints the flags each
// time they change; letting go of the chord's Control or Option ends the press. It runs only
// while listening and ends itself after MAX_S, so nothing polls at rest.

const childProcess = require('child_process');

// NSEventModifierFlags bits.
const FLAG = { shift: 1 << 17, control: 1 << 18, alt: 1 << 19, command: 1 << 20 };
const MAX_S = 25;
const POLL_S = 0.03;

const NAMES = { control: 'control', ctrl: 'control', alt: 'alt', option: 'alt', shift: 'shift', command: 'command', cmd: 'command', commandorcontrol: 'command', cmdorctrl: 'command' };

// 'Control+Alt+Space' -> ['control', 'alt']: the modifiers whose release ends the press.
// CommandOrControl is Command on a Mac. No modifiers -> [] (nothing to watch).
function macChordMods(accelerator) {
  const mods = [];
  for (const p of String(accelerator || '').split('+').map((s) => s.trim().toLowerCase())) {
    const m = NAMES[p];
    if (m && !mods.includes(m)) mods.push(m);
  }
  return mods;
}

// Are all of the chord's modifiers down in this flags value?
function chordHeld(flags, mods) {
  const f = Number(flags) || 0;
  return mods.length > 0 && mods.every((m) => (f & FLAG[m]) !== 0);
}

const MASK = FLAG.shift | FLAG.control | FLAG.alt | FLAG.command;
const SCRIPT = [
  'ObjC.import("AppKit");',
  'var t0 = Date.now(), last = -1;',
  'while (Date.now() - t0 < ' + MAX_S * 1000 + ') {',
  '  var m = $.NSEvent.modifierFlags & ' + MASK + ';',
  '  if (m !== last) { last = m; console.log("f " + m); }',
  '  delay(' + POLL_S + ');',
  '}',
].join('\n');

// Calls onChange(held: boolean) on each change of whether the chord is down, the first reading
// included. Returns { stop() }. onError(message) if osascript cannot run; the caller then keeps
// the press-again toggle.
function watchChordRelease({ mods, onChange, onError, spawn } = {}) {
  const run = typeof spawn === 'function' ? spawn : childProcess.spawn;
  let child = null;
  let stopped = false;
  let held = null;
  let buf = '';
  function stop() {
    stopped = true;
    if (child) { try { child.kill(); } catch (_) { /* already gone */ } child = null; }
  }
  try {
    child = run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', SCRIPT], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (e) {
    if (onError) onError(e.message);
    return { stop };
  }
  // JXA's console.log writes to stderr.
  child.stderr.on('data', (d) => {
    if (stopped) return;
    buf += String(d);
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = /^f (\d+)$/.exec(line);
      if (!m) continue;
      const now = chordHeld(Number(m[1]), mods);
      if (now === held) continue;
      held = now;
      if (onChange) onChange(now);
      if (stopped) return;
    }
  });
  child.on('error', (e) => { if (!stopped && onError) onError(e.message); });
  child.on('exit', () => { child = null; });
  return { stop };
}

module.exports = { FLAG, macChordMods, chordHeld, watchChordRelease, SCRIPT };
