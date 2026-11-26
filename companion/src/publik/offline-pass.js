'use strict';
// A person who has signed in with publik on this computer before can open Nūs when publik does
// not answer. Until 0.1.31
// they sat at "publik is not reachable" with only Retry: 17 of 141 installs had met that screen,
// and with no internet Nūs did not open at all, though voice commands, reminders and notes need
// neither publik nor the internet.
//
// publik's own module (publik.js) is not changed. It is handed a window that behaves like the
// real one with one difference, and only for a computer that has signed in before:
//   - when the module asks for its "not reachable" screen, Nūs opens instead, and the module is
//     told to retry once a minute in the background, with no window;
//   - when publik has not answered at all after NO_ANSWER_MS, Nūs opens too (the module's own
//     timeout is 15 s);
//   - once publik answers again the module finishes by itself (its counting starts then). If it
//     wants a screen instead (signed out at publik, a key that was taken back), that waits for
//     the next start: a sign-in window never comes up in the middle of a session.
// A computer that never signed in gets publik's gate exactly as before. So does a start where
// publik answered and showed one of its screens: after that, nothing here lets anyone through.
const BACKGROUND_RETRY_MS = 60_000;
const NO_ANSWER_MS = 8_000;
const never = () => new Promise(() => {});
const wait = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); if (t && t.unref) t.unref(); });

// ensureSignedIn(ui) -> the module's promise. ui: { show, openUrl, close }. signedInBefore() -> boolean.
// Resolves { signed, offline }: signed is the module's answer (null when let through without it),
// offline is '' or why the person was let through ('unreachable' | 'no_answer').
// onBack(signed): publik answered later in the same session and the module finished.
function passGate({ ensureSignedIn, ui, signedInBefore, onBack = () => {}, retryMs = BACKGROUND_RETRY_MS, noAnswerMs = NO_ANSWER_MS, sleep = wait }) {
  let before = false;
  try { before = !!signedInBefore(); } catch (_) { before = false; }
  if (!before) return Promise.resolve(ensureSignedIn(ui)).then((signed) => ({ signed, offline: '' }));

  let through = '', answered = false, done = false, open;
  const opened = new Promise((resolve) => { open = resolve; });
  let timer = null;
  const letThrough = (why) => { if (through || answered || done) return; through = why; clearTimeout(timer); open(why); };
  const window = {
    show(screen, signal) {
      const unreachable = !!screen && screen.id === 'unreachable';
      if (unreachable && !answered) {
        letThrough('unreachable');
        return sleep(retryMs).then(() => (signal && signal.aborted ? never() : 'retry'));
      }
      if (through) return never();
      answered = true; clearTimeout(timer);
      return ui.show(screen, signal);
    },
    openUrl(url) { return ui.openUrl(url); },
    close() { return ui.close(); },
  };
  timer = setTimeout(() => letThrough('no_answer'), noAnswerMs);
  const real = Promise.resolve().then(() => ensureSignedIn(window)).then((signed) => {
    done = true; clearTimeout(timer);
    if (through) { try { onBack(signed); } catch (_) { /* a listener, never a failure */ } }
    return signed;
  });
  // A failure after the person is already in belongs to nobody; before that it is the caller's, as it was.
  real.catch(() => {});
  return Promise.race([real.then((signed) => ({ signed, offline: '' })), opened.then((why) => ({ signed: null, offline: why }))]);
}

module.exports = { passGate, BACKGROUND_RETRY_MS, NO_ANSWER_MS };
