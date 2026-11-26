'use strict';
// Dictation (0.1.37 test, ventures/nus/conditor/dictate-0137/README.md): hold
// Ctrl and Win, speak, let go, and the words go in wherever the text cursor is,
// in any app. Speech runs on this computer (Parakeet, whisper as the fallback)
// and the words go in through the Hands paste that Rewrite and "type ..." use,
// which puts the old clipboard back. No AI model is asked, nothing is counted
// against any allowance, and it works offline and with no sign-in.
//
// Pure: no Electron, no timers, no files except through what is passed in, so
// every rule here is tested on its own (companion/test/dictate.test.js).
//
// Why Ctrl + Win (checked on Pranav's PC 2026-11-23): Windows binds Ctrl+Win
// only together with a third key (D, the arrows, F4, Enter, O, C, Q, Shift+B),
// never on its own, and letting go of Ctrl+Win in either order does not open
// Start (a lone Win tap does). Wispr Flow and Clicky use the same pair on
// Windows. It shares Ctrl with the talk key (Ctrl+Alt), so the two exclude
// each other: Alt or Shift joining a held Ctrl+Win cancels the dictation, and
// the talk key never starts while a Win key is down.
const crypto = require('crypto');

const VK = { control: 17, lcontrol: 162, rcontrol: 163, alt: 18, lalt: 164, ralt: 165, shift: 16, lshift: 160, rshift: 161, lwin: 91, rwin: 92 };
// The keys the probe must watch for this chord, on top of the talk key's.
const WIN_VKS = [VK.lwin, VK.rwin];
const DICTATE_KEYS = 'Control+Win';
const DICTATE_KEYCAPS = ['Ctrl', 'Win'];
// The split: half of installs, from the install id, so the server can work out
// the same half from the install_id it already stores (no new prop is sent).
// SQL twin: get_byte(sha256(convert_to(install_id || '|dictate-0137', 'UTF8')), 0) % 2 = 0.
const ARM_SALT = '|dictate-0137';
// A hold shorter than this with no speech is a Windows shortcut on the same
// keys (Ctrl+Win+D, Ctrl+Win+Left): it ends without a word, like the talk key.
const TAP_MS = 300;
// Long enough for a paragraph; the talk key allows 20 s.
const MAX_MS = 60000;
// Two dictations into the same window this close together are one piece of
// writing: the second starts with a space so the sentences do not run together.
const JOIN_MS = 2 * 60 * 1000;

function armOf(installId) {
  const id = String(installId || '');
  if (!id) return 'off';
  return crypto.createHash('sha256').update(id + ARM_SALT, 'utf8').digest()[0] % 2 === 0 ? 'on' : 'off';
}

// The Settings switch wins either way; unset follows the half the install is in.
function enabled(settings, installId) {
  const s = settings || {};
  if (s.dictation === true) return true;
  if (s.dictation === false) return false;
  return armOf(installId) === 'on';
}
// What the person sees in Settings and what the log says: why it is on or off.
function why(settings, installId) {
  const s = settings || {};
  if (s.dictation === true || s.dictation === false) return 'setting';
  return 'arm-' + armOf(installId);
}

// Ctrl + Win held, nothing else among the modifiers. -> 'down' | 'up' | 'cancel' | null per report.
function createDictateChord() {
  const down = new Set();
  let held = false;
  const any = (...vks) => vks.some((v) => down.has(v));
  const ctrl = () => any(VK.control, VK.lcontrol, VK.rcontrol);
  const win = () => any(VK.lwin, VK.rwin);
  const other = () => any(VK.alt, VK.lalt, VK.ralt, VK.shift, VK.lshift, VK.rshift);
  function onKey(vk, isDown) {
    vk = Number(vk);
    if (!Object.values(VK).includes(vk)) return null;
    if (isDown) down.add(vk); else down.delete(vk);
    if (held && other()) { held = false; return 'cancel'; }
    const now = ctrl() && win() && !other();
    if (now && !held) { held = true; return 'down'; }
    if (!now && held) { held = false; return 'up'; }
    return null;
  }
  function reset() { down.clear(); held = false; }
  return { onKey, reset, get held() { return held; }, get winDown() { return win(); } };
}

// Ctrl + Win is held for other things too: Windows' own shortcuts, a habit, a
// game. So nothing wakes, no mic and no Knot, unless the
// keyboard focus is somewhere words can go. The probe reports facts about the
// focus (companion/src/win/probe.ps1 'focus.text'); this decides.
//   'yes'      a text box, a document being edited, a terminal
//   'no'       the desktop, a list of files, a button, a page with no box in focus
//   'ours'     a Nūs window is in front (only the tour's dictation card dictates then)
//   'unknown'  the app says nothing about its focus: dictation still starts,
//              or an app with no accessibility would never get it
// retry: a browser or Electron window turns its accessibility on at the first
// question and answers properly a moment later, so one more look is worth it.
const SHELL_CLASSES = ['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd'];
const TERMINAL_CLASSES = ['CASCADIA_HOSTING_WINDOW_CLASS', 'ConsoleWindowClass', 'VirtualConsoleClass', 'mintty', 'PuTTY'];
const WEB_CLASS = /^(Chrome_WidgetWin_|MozillaWindowClass)/;
const TEXT_TYPES = ['Edit', 'Document', 'ComboBox'];
const BLIND_TYPES = ['Pane', 'Window'];
const NEVER_TYPES = ['Button', 'SplitButton', 'MenuItem', 'Menu', 'MenuBar', 'TabItem', 'Tab', 'Hyperlink', 'CheckBox', 'RadioButton',
  'ListItem', 'List', 'TreeItem', 'Tree', 'DataItem', 'DataGrid', 'Table', 'Header', 'HeaderItem', 'Image', 'Slider', 'ScrollBar',
  'ProgressBar', 'ToolBar', 'StatusBar', 'TitleBar', 'Thumb', 'Separator', 'ToolTip', 'Calendar'];
function focusTakesText(f, opts) {
  const second = Boolean(opts && opts.second);
  if (!f || typeof f !== 'object') return { text: 'unknown', why: 'no answer' };
  if (f.ours) return { text: 'ours', why: 'nus in front' };
  if (f.password) return { text: 'no', why: 'password' };
  const cls = String(f.cls || ''), type = String(f.type || '');
  if (SHELL_CLASSES.includes(cls)) return { text: 'no', why: 'desktop' };
  if (TERMINAL_CLASSES.includes(cls)) return { text: 'yes', why: 'terminal' };
  // A caret is the plainest sign (Notepad, Word, and the caret Chrome, Edge and
  // Electron apps report: the Claude and ChatGPT boxes are a bare Group with one).
  if (f.caret) return { text: 'yes', why: 'caret' };
  if (NEVER_TYPES.includes(type)) return { text: 'no', why: type };
  if (f.hasValue) return f.readOnly === true ? { text: 'no', why: 'read-only ' + (type || 'field') } : { text: 'yes', why: (type || 'field') + ' value' };
  if (f.hasText && f.textReadOnly === false) return { text: 'yes', why: (type || 'field') + ' text' };
  if (f.hasText && f.textReadOnly === true) return { text: 'no', why: 'read-only ' + (type || 'text') };
  if (TEXT_TYPES.includes(type) && type !== 'ComboBox') return { text: 'yes', why: type };
  const web = WEB_CLASS.test(cls);
  // Pane, Window or nothing: the app has not described its page (Firefox with
  // its accessibility asleep, measured 2026-11-23, answers Pane every time).
  const blind = !type || BLIND_TYPES.includes(type);
  // A browser that has described its page twice and still shows no box has none in focus.
  if (web && second && !blind) return { text: 'no', why: 'no box in focus (' + type + ')' };
  return { text: 'unknown', why: type || 'no focus', retry: web && !second };
}
// Does this verdict start a dictation? tourDictating: the tour's dictation card is up.
function gateOpens(verdict, tourDictating) {
  const t = verdict && verdict.text;
  return t === 'yes' || t === 'unknown' || (t === 'ours' && Boolean(tourDictating));
}

// Parakeet writes sentences with their own capitals and full stops; this only
// tidies the edges. '' when there is nothing worth putting in.
function tidy(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t || !/[\p{L}\p{N}]/u.test(t)) return '';
  return t;
}
// The words as they go in. prev: { hwnd, at } of the last dictation that landed.
function textToPaste(text, target, prev, now) {
  const t = tidy(text);
  if (!t) return '';
  const same = prev && target && prev.hwnd && prev.hwnd === target.hwnd && now - prev.at < JOIN_MS;
  return same ? ' ' + t : t;
}

// The window the words go to: the one in front when the keys went down. If
// that was Nūs itself (a tour card, the dashboard), the window behind it.
// fg: the probe's answer for the front window, behind: its answer ignoring our pid.
function pickTarget(fg, behind, selfPid) {
  if (fg && fg.hwnd && Number(fg.pid) !== Number(selfPid)) return { hwnd: fg.hwnd, process: fg.process || '', title: fg.title || '', behindSelf: false };
  if (behind && behind.hwnd && Number(behind.pid) !== Number(selfPid)) return { hwnd: behind.hwnd, process: behind.process || '', title: behind.title || '', behindSelf: true };
  return null;
}

// How a dictation ended, in the stats list's words (companion/src/stats.js OUTCOMES).
function outcomeOf(r) {
  if (!r) return 'failed';
  if (r.cancelled) return 'cancelled';
  if (!r.text) return 'failed';
  if (r.paste && r.paste.ok && r.paste.how !== 'none') return 'ok';
  return 'failed';
}

// The transcript check (dogfood only): one JSON line per dictation, with the
// raw words and the timings, so 20 real sentences can be scored afterwards
// (scripts/dictate-check.js score). Only when the flag file is there.
function checkLine(d) {
  return JSON.stringify({
    at: new Date(d.at || Date.now()).toISOString(), n: d.n, audioMs: Math.round(d.audioMs || 0), engine: d.engine || '',
    decodeMs: Math.round(d.decodeMs || 0), loadMs: Math.round(d.loadMs || 0), keyUpToPasteMs: Math.round(d.keyUpToPasteMs || 0),
    raw: String(d.raw || ''), pasted: String(d.pasted || ''), how: d.how || '', verified: d.verified == null ? null : !!d.verified,
    app: d.app || '', wav: d.wav || '',
  });
}

module.exports = { VK, WIN_VKS, DICTATE_KEYS, DICTATE_KEYCAPS, ARM_SALT, TAP_MS, MAX_MS, JOIN_MS, armOf, enabled, why, createDictateChord, focusTakesText, gateOpens, tidy, textToPaste, pickTarget, outcomeOf, checkLine };
