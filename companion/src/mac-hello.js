'use strict';
// The first-run hello on a Mac: the Windows hello (companion/src/hello.js) types into Notepad
// through the PowerShell helper; a Mac has neither, so here one AppleScript asks TextEdit for a new
// document and sets its text one character at a time, live. The same words as on Windows.
//
// The one permission it needs is macOS's Automation for TextEdit (a single "Nus Companion wants
// access to control TextEdit" prompt; the words come from NSAppleEventsUsageDescription). It sends no
// keystrokes, so it needs no Accessibility. It only ever touches the document it made, and it stops
// at once when TextEdit leaves the front, when that document's text is no longer what it typed (the
// person typed in it), on Esc, or after a time limit. Refused, or anything else wrong: nothing is
// typed, nothing is retried, and the hello card says its untyped line.
//
// Pure Node: spawn and the clock are injectable for the tests.
const { spawn: nodeSpawn } = require('child_process');

const CHAR_DELAY_S = 0.055;   // as on Windows (hello.js CHAR_MS)
const LINE_DELAY_S = 0.38;    // a beat after each line (hello.js LINE_PAUSE_MS)
const LIMIT_MS = 45000;       // the Automation prompt waits for the person; this is their time too

// The AppleScript, one `-e` line each. argv 1 is the text. It prints "typed N" or "stopped N <why>".
const SCRIPT = [
  'on run argv',
  '  set t to item 1 of argv',
  '  set n to count of characters of t',
  '  tell application "TextEdit"',
  '    set d to make new document',
  '    activate',
  '    delay 0.6',
  '    set shown to ""',
  '    repeat with i from 1 to n',
  '      if frontmost is false then return "stopped " & (i - 1) & " front"',
  '      if (text of d) is not shown then return "stopped " & (i - 1) & " typed"',
  '      set shown to (text 1 thru i of t)',
  '      set text of d to shown',
  '      if character i of t is linefeed then',
  `        delay ${LINE_DELAY_S}`,
  '      else',
  `        delay ${CHAR_DELAY_S}`,
  '      end if',
  '    end repeat',
  '  end tell',
  '  return "typed " & n',
  'end run',
];

function args(text) { return SCRIPT.flatMap((line) => ['-e', line]).concat([String(text)]); }

// What osascript said, as the hello's result ({ outcome, why, typed }, like hello.js Hello.run).
function readResult(code, out, err) {
  const o = String(out || '').trim(), e = String(err || '');
  let m = /^typed (\d+)/.exec(o);
  if (code === 0 && m) return { outcome: 'typed', why: '', typed: Number(m[1]) };
  m = /^stopped (\d+) (\w+)/.exec(o);
  if (code === 0 && m) return { outcome: 'stopped', why: m[2] === 'front' ? 'TextEdit left the front' : 'the person typed', typed: Number(m[1]) };
  if (/-1743|not authori[sz]ed|Not allowed to send Apple events/i.test(e)) return { outcome: 'skipped', why: 'Automation for TextEdit not allowed', typed: 0 };
  if (/-1728|-600|isn.t running|Can.t get application/i.test(e)) return { outcome: 'skipped', why: 'TextEdit not available', typed: 0 };
  return { outcome: 'skipped', why: 'osascript ' + (code == null ? 'stopped' : 'exit ' + code) + (e ? ': ' + e.trim().slice(0, 160) : ''), typed: 0 };
}

// -> Promise<{ outcome, why, typed }>. aborted(): true stops it (Esc, the tour moved on).
function runMacHello(text, { spawn = nodeSpawn, aborted = () => false, limitMs = LIMIT_MS, setTimer = setInterval, clearTimer = clearInterval } = {}) {
  return new Promise((resolve) => {
    let child, out = '', err = '', done = false, waited = 0;
    const finish = (r) => { if (done) return; done = true; clearTimer(timer); resolve(r); };
    try { child = spawn('osascript', args(text), { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve({ outcome: 'skipped', why: 'osascript would not start: ' + e.message, typed: 0 }); return; }
    const timer = setTimer(() => {
      waited += 250;
      if (aborted() || waited >= limitMs) { try { child.kill(); } catch (_) { /* gone */ } finish({ outcome: aborted() ? 'stopped' : 'skipped', why: aborted() ? 'Esc' : 'no answer in ' + Math.round(limitMs / 1000) + ' s (the Automation question still open?)', typed: 0 }); }
    }, 250);
    if (child.stdout) child.stdout.on('data', (d) => { out += d; });
    if (child.stderr) child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ outcome: 'skipped', why: 'osascript: ' + e.message, typed: 0 }));
    child.on('close', (code) => finish(readResult(code, out, err)));
  });
}

module.exports = { runMacHello, readResult, args, SCRIPT, LIMIT_MS };
