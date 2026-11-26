'use strict';
// The first-run hello (Pranav, 2026-11-11): right after sign-in, before any card, the Knot opens
// Notepad and types into it, live, so a new person sees Nūs act on their computer before they have
// said a word. Then the Knot says "Hey, I'm Nūs. That was me. Wanna see what else I can do?" and
// Show me starts the tour. Brought back from e586f8b (2026-11-07, never released), with these rules:
// - It is the app's own scripted demo: no key of any kind, no model, and Hands may be switched off.
// - It types ONLY into the Notepad window it opened, and only while that window is in front. The
//   helper (reflex/hands.ps1, keys.slow) checks before every character: the window is still there,
//   still in front, and the person is not pressing a key or a mouse button. Otherwise it stops at
//   once and the Knot's line comes next. Esc stops it too.
// - Windows 11's Notepad brings back earlier unsaved tabs, so the text goes into a fresh empty tab
//   (Ctrl+N), and nothing is typed unless that document reads as empty. It never saves or closes.
// - The corner named matches where the Knot is on that screen.
// - Notepad is brought forward if it opened behind; if it still is not in front, nothing is typed
//   and the Knot's line comes first.
//
// Pure Node: main (companion/index.js) passes the Windows parts in, so the tests run with fakes.

// The words typed into Notepad. A: GPT's version, the default Pranav pasted. B: his own.
const STUNTS = {
  A: (where) => "You didn't open this.\nI did.\n\nI'm Nūs!\n\nLook at the " + where.long + ' of your screen.',
  B: (where) => 'Welcome to Nūs. Please look at the Knot at the ' + where.plain + ' to begin',
};
const STUNT_PICK = 'A';
const LINE_PAUSE_MS = 380;   // a beat after each line, so it reads as typed by someone
const CHAR_MS = 55;          // one character every 55 ms, about 18 a second
const FRONT_WAIT_MS = 7000;  // a cold Notepad start on a slow laptop
const NUDGE_AT_MS = [1200, 3500]; // when Notepad is brought forward if it has not come by itself

// Where the Knot is, in the words the note uses. pos: { fx, fy } as fractions of the screen, island.
function where(pos) {
  const p = pos || {};
  if (p.island) return { long: 'top', plain: 'top of your screen' };
  const v = Number(p.fy) < 0.5 ? 'top' : 'bottom', h = Number(p.fx) < 0.5 ? 'left' : 'right';
  return { long: v + '-' + h + ' corner', plain: v + ' ' + h + ' corner' };
}
function text(pick, pos) { return (STUNTS[pick] || STUNTS[STUNT_PICK])(where(pos)); }
// The text in the pieces it is typed in: one line each, the line break with it.
function chunks(t) { const lines = String(t).split('\n'); return lines.map((l, i) => (i < lines.length - 1 ? l + '\n' : l)).filter((c) => c.length); }

// The run. deps: { launch(), front() -> { hwnd, process, title } | null, slow(args) -> helper result,
// press(keys, hwnd), nudge() (bring Notepad forward), sleep(ms), now(), aborted() -> bool, win11: bool, log(m), pick, pos }
// -> { outcome: 'finished' | 'interrupted' | 'skipped', why, typed }
async function run(deps) {
  const d = Object.assign({ sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: Date.now, aborted: () => false, log: () => {}, win11: true, pick: STUNT_PICK }, deps || {});
  const isPad = (fg) => !!(fg && fg.hwnd && /^notepad(\.exe)?$/i.test(String(fg.process || '')));
  try { d.launch(); } catch (e) { return { outcome: 'skipped', why: 'notepad did not start: ' + e.message, typed: 0 }; }
  // Notepad should come to the front by itself. Windows often keeps the window that had the focus
  // (walk 2026-11-11: Notepad opened behind), so after a moment Notepad is brought forward, twice
  // at most (deps.nudge, the same helper call Hands uses to bring an app forward). Only Notepad.
  let fg = null, lastSeen = null, answered = false;
  const start = d.now(), nudges = [NUDGE_AT_MS[0], NUDGE_AT_MS[1]];
  for (const end = start + FRONT_WAIT_MS; d.now() < end; ) {
    if (d.aborted()) return { outcome: 'skipped', why: 'stopped', typed: 0 };
    try { fg = await d.front(); } catch (_) { fg = null; }
    if (fg && fg.hwnd) { answered = true; lastSeen = fg; }
    if (isPad(fg)) break;
    fg = null;
    if (nudges.length && d.now() - start >= nudges[0] && typeof d.nudge === 'function') { nudges.shift(); try { await d.nudge(); } catch (_) { /* keep looking */ } }
    await d.sleep(200);
  }
  // Why, in the log every time (Pranav's run, 2026-11-11, typed nothing: the window helper was not running).
  if (!fg) return { outcome: 'skipped', why: answered ? 'notepad never came to the front (in front: ' + String(lastSeen.process || '?') + ')' : 'the window helper could not say which window is in front', typed: 0 };
  const hwnd = fg.hwnd;
  await d.sleep(500);
  // A fresh, empty document. A restored Windows 11 tab may be the person's own note: Ctrl+N gives
  // a new tab, and nothing is typed unless the document reads as empty.
  let check = await d.slow({ hwnd, text: '', requireEmpty: true });
  // Another of the app's own windows took the focus in that half second (walk 2026-11-11: the
  // dashboard and the Knot's window were still opening): Notepad is brought back once, and it
  // must be the same window, in front, before anything goes on.
  if (check && check.stopped === 'focus' && typeof d.nudge === 'function') {
    try { await d.nudge(); } catch (_) { /* checked below */ }
    await d.sleep(400);
    let again = null; try { again = await d.front(); } catch (_) { again = null; }
    if (again && again.hwnd === hwnd) check = await d.slow({ hwnd, text: '', requireEmpty: true });
  }
  if (check && check.stopped && check.stopped !== 'not_empty') return { outcome: 'skipped', why: 'before typing: ' + check.stopped, typed: 0 };
  const unread = !!(check && check.ok && check.empty == null);
  if (!(check && check.ok && check.empty === true) && d.win11 && (unread || (check && check.stopped === 'not_empty'))) {
    let now = null; try { now = await d.front(); } catch (_) { now = null; }
    if (!now || now.hwnd !== hwnd) return { outcome: 'skipped', why: 'notepad lost the front before the new tab', typed: 0 };
    await d.press('ctrl+n', hwnd);
    await d.sleep(600);
    check = await d.slow({ hwnd, text: '', requireEmpty: true });
  }
  if (!check || !check.ok) return { outcome: 'skipped', why: 'no empty document: ' + ((check && (check.stopped || check.refused)) || 'no answer'), typed: 0 };
  let typed = 0;
  for (const piece of chunks(text(d.pick, d.pos))) {
    if (d.aborted()) return { outcome: 'interrupted', why: 'esc', typed };
    const r = await d.slow({ hwnd, text: piece, delayMs: CHAR_MS });
    typed += (r && r.typed) || 0;
    if (!r || !r.ok) return { outcome: typed ? 'interrupted' : 'skipped', why: (r && (r.stopped || r.refused || r.error)) || 'no answer', typed };
    await d.sleep(LINE_PAUSE_MS);
  }
  return { outcome: 'finished', why: '', typed };
}

module.exports = { STUNTS, STUNT_PICK, CHAR_MS, LINE_PAUSE_MS, FRONT_WAIT_MS, NUDGE_AT_MS, where, text, chunks, run };
