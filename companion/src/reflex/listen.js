// Streaming ears for the reflex engine. PCM chunks in (16 kHz mono Int16),
// partial and final transcripts out, all local.
//
// whisper.cpp pads every clip to 30 s, which costs about 2 s however short the
// audio is. Shrinking the encoder's audio context to fit the clip (-ac) brings
// a 2 s clause down to about 0.6 s on this machine (measured 2026-09-20, base.en
// q5_1, 8 threads) with the same words out. So: cut speech into short segments
// at pauses, and keep re-transcribing the segment in progress.
//
//   onPartial(text)  the segment so far, while the person is still talking
//   onFinal(text)    the finished segment, after a pause or an explicit flush()
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pcmToWav, rms16 } = require('../wav');
const { sharedWhisperServer, serverBeside, runnableCopy, audioCtxFor } = require('../../../src/whisper-server');
// whisper-cli.exe on Windows; whisper-cli on a Mac (the Mac beta bundles one, built on the macOS runner).
const CLI_NAME = process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli';
const { echoesPrompt } = require('./prompt-echo');

const RATE = 16000;
const BYTES_PER_MS = (RATE * 2) / 1000;
const CFG = {
  speechRms: 400,        // a chunk louder than this is speech (Pranav's SoloCast, measured live: speech ~1500 to 2100, room ~30 to 55)
  pauseMs: 450,          // this much quiet after speech ends the segment (320 cut Pranav's natural pauses mid-command)
  minSpeechMs: 350,      // ignore coughs and clicks
  firstPartialMs: 650,   // do not transcribe less than this
  partialEveryMs: 300,   // new audio needed before another partial
  maxSegmentMs: 9000,    // a segment is force-ended here (audio context stays small)
  finalBudgetMs: 3000,   // a final the resident whisper has not answered by now: it has stalled, whisper-cli takes over
  betterFinalBudgetMs: 1500, // Parakeet answers in about 0.3 s (voice/parakeet.js); past this whisper answers instead
  slowPartialMs: 700,    // a final waits no longer than this for a partial that heard everything (they take 200 to 400 ms)
  preRollMs: 200,        // keep a little quiet before the first loud chunk
  wholeBudgetMs: 3500    // the careful decode of a whole press (about 1.2 s measured); past this the fast words stand
};

function findWhisper(userData) {
  const dirs = [];
  if (process.env.NUS_WHISPER_DIR) dirs.push(process.env.NUS_WHISPER_DIR);
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'whisper'));
  dirs.push(path.join(__dirname, '..', '..', '..', 'vendor', 'whisper'));
  dirs.push(path.join(__dirname, '..', '..', '..', '..', 'nus-desktop', 'vendor', 'whisper'));
  let exe = null;
  for (const d of dirs) { const f = path.join(d, CLI_NAME); if (fs.existsSync(f)) { exe = runnableCopy(f, userData); break; } }
  const mdirs = [];
  if (userData) mdirs.push(path.join(userData, 'whisper-models'));
  if (process.resourcesPath) mdirs.push(path.join(process.resourcesPath, 'whisper-models'));
  mdirs.push(path.join(__dirname, '..', '..', '..', 'vendor', 'whisper-models'));
  let model = null;
  // base before small: a partial has to come back in well under a second.
  for (const name of ['ggml-base.en-q5_1.bin', 'ggml-small.en-q5_1.bin']) {
    for (const d of mdirs) { const f = path.join(d, name); if (!model && fs.existsSync(f)) model = f; }
  }
  return { exe, model, server: serverBeside(exe) };
}

// audioCtxFor (src/whisper-server.js): the encoder context sized to the clip.

// Names whisper should expect: the product and the people and courses the
// person has told Nūs about. "Nūs Companion" came back as "News Companion" and
// "Professor Lee" as "professionally" live 2026-10-11. Short on purpose: a long
// prompt makes whisper echo it on silence. No bare "Nūs" or "the Knot": measured
// 2026-11-04 on 16 of Pranav's clips, they turned "Open Notepad" into "Open Nupad"
// (Notepad heard 1 of 3 with them, 3 of 3 without, same model).
const VOCAB_MAX = 14;
function vocabularyPrompt(words) {
  const seen = new Set();
  const out = ['Nūs Companion'];
  for (const w of out) seen.add(w.toLowerCase());
  for (const raw of Array.isArray(words) ? words : []) {
    const w = String(raw || '').replace(/\s+/g, ' ').trim();
    if (w.length < 2 || w.length > 40 || seen.has(w.toLowerCase())) continue;
    seen.add(w.toLowerCase());
    out.push(w);
    if (out.length >= VOCAB_MAX) break;
  }
  return out.join(', ') + '.';
}

function runWhisper(exe, model, wavPath, ms, budgetMs, prompt, onChild, spawnFn = spawn) {
  return new Promise((resolve) => {
    const threads = Math.max(2, Math.min(8, os.cpus().length));
    const args = ['-m', model, '-f', wavPath, '-l', 'en', '-t', String(threads), '-ac', String(audioCtxFor(ms)), '-nf', '-bo', '1', '-bs', '1', '-nt', '-np'];
    if (prompt) args.push('--prompt', String(prompt));
    let child;
    try { child = spawnFn(exe, args, { windowsHide: true }); } catch (e) { return resolve(''); }
    if (onChild) onChild(child);
    let out = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, budgetMs || 8000);
    child.stdout.on('data', (d) => { out += d.toString('utf8'); });
    child.stderr.on('data', () => {});
    child.on('error', () => { clearTimeout(timer); resolve(''); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

// whisper can fall into a loop and emit one phrase dozens of times from a few
// seconds of audio (live 2026-09-21: "then go to Firefox and" x43, which opened
// 43 windows). Any phrase of 1 to 12 words said three or more times in a row is
// kept once. Nobody talks like that; a decoder does.
function collapseLoops(text) {
  const w = String(text || '').split(/\s+/).filter(Boolean);
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9']/g, '');
  const out = [];
  let i = 0;
  while (i < w.length) {
    let collapsed = false;
    for (let n = 1; n <= 12 && i + 3 * n <= w.length; n++) {
      let reps = 1;
      while (i + (reps + 1) * n <= w.length && w.slice(i, i + n).every((x, k) => key(x) === key(w[i + reps * n + k]))) reps++;
      if (reps >= 3) { out.push(...w.slice(i, i + n)); i += reps * n; collapsed = true; break; }
    }
    if (!collapsed) { out.push(w[i]); i++; }
  }
  return out.join(' ');
}

// Fast speech is about 4 words a second. More words than the audio could hold
// means the decoder invented them; the whole transcript is thrown away.
function plausible(text, audioMs) {
  const words = String(text || '').split(/\s+/).filter(Boolean).length;
  return words <= Math.ceil((audioMs / 1000) * 5) + 3;
}

// whisper also says a whole sentence twice ("Type hello from Nūs. Type hello
// from Nūs.", live 2026-09-21). Back to back identical sentences are kept once.
function dropRepeatedSentences(text) {
  const parts = String(text || '').match(/[^.!?]+[.!?]*/g) || [];
  const key = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const out = [];
  for (const p of parts) {
    if (out.length && key(p) && key(p) === key(out[out.length - 1])) continue;
    out.push(p.trim());
  }
  return out.join(' ');
}

function clean(text, audioMs) {
  let t = String(text || '').replace(/\[[^\]]*\]/g, '').replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  t = dropRepeatedSentences(collapseLoops(t));
  if (audioMs && !plausible(t, audioMs)) return '';
  return t.length > 1 ? t : '';
}

// finalEngine (optional, voice/parakeet.js): { name, wanted(), ready(), transcribe(pcm) -> words }.
// When it is ready it answers every final, in place of whisper and of a reused
// partial. Partials stay on whisper. Not loaded, an error, no words or over budget:
// whisper answers at once, so a person is never left without words.
function createListener({ userData, onPartial, onFinal, onCommand, log, transcribe, vocabulary, server: injectedServer, spawn: spawnFn, finalEngine }) {
  const say = log || (() => {});
  const found = transcribe ? { exe: 'x', model: 'x' } : findWhisper(userData);
  // The resident whisper (src/whisper-server.js): about 0.25 s less per
  // transcription than starting whisper-cli. Until it is up, whisper-cli.
  const server = injectedServer || (!transcribe && found.server ? sharedWhisperServer({ exe: found.server, model: found.model, log: say }) : null);
  if (server) server.warm();
  const promptFor = () => { try { return vocabularyPrompt(typeof vocabulary === 'function' ? vocabulary() : vocabulary); } catch (_) { return vocabularyPrompt([]); } };
  const tmpDir = path.join(userData || os.tmpdir(), 'voice-tmp');
  let seg = []; let segMs = 0; let speechMs = 0; let quietMs = 0; let preRoll = [];
  let lastPartialAtMs = 0; let busy = false; let speechEndedAt = 0; let gen = 0;
  let lastPartial = { gen: -1, speechMs: 0, text: '' };
  let epoch = 0;
  // The partial whisper-cli in flight: its segment, how much speech it heard,
  // and how to stop it when a final arrives and it can no longer be that final.
  let inFlight = null;
  // Loudness of the current segment, logged with every final so the speech
  // threshold can be tuned to a real mic in a real room instead of guessed.
  let loudSum = 0; let loudN = 0; let quietSum = 0; let quietN = 0;

  // budgetMs: this is a partial. A partial the resident whisper could not answer
  // is stale, not a reason to start whisper-cli on top of it: that second decode
  // held up the final behind it (live 2026-11-03: finals of 1.3 to 4.0 s, about
  // 0.3 s without one of these in the way).
  async function stt(pcm, ms, budgetMs, onChild, signal) {
    if (transcribe && !injectedServer) return clean(await transcribe(pcm, ms), ms);
    const wavBytes = pcmToWav(pcm, RATE, 1);
    if (server) {
      const up = server.status().state === 'ready';
      const words = await server.transcribe(wavBytes, { audioCtx: audioCtxFor(ms), prompt: promptFor(), timeoutMs: budgetMs || CFG.finalBudgetMs, signal, partial: Boolean(budgetMs) });
      if (words != null) return clean(words, ms);
      if (budgetMs && up) return '';
    }
    if (transcribe) return clean(await transcribe(pcm, ms), ms);
    fs.mkdirSync(tmpDir, { recursive: true });
    const wav = path.join(tmpDir, 'seg-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '.wav');
    fs.writeFileSync(wav, wavBytes);
    try { return clean(await runWhisper(found.exe, found.model, wav, ms, budgetMs, promptFor(), onChild, spawnFn), ms); }
    finally { try { fs.unlinkSync(wav); } catch (_) {} }
  }

  const engineCan = (fn) => { try { return Boolean(finalEngine && finalEngine[fn]()); } catch (_) { return false; } };

  // Resolves to { text } with the engine's words, or { why } when whisper must answer.
  async function betterFinal(pcm, ms) {
    let timer = null;
    try {
      const overBudget = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('over budget')), CFG.betterFinalBudgetMs); });
      const words = await Promise.race([finalEngine.transcribe(pcm), overBudget]);
      const text = clean(words, ms);
      return text ? { text } : { why: 'no words' };
    } catch (e) {
      return { why: String((e && e.message) || e).slice(0, 80) };
    } finally { clearTimeout(timer); }
  }

  function resetSegment() { seg = []; segMs = 0; speechMs = 0; quietMs = 0; lastPartialAtMs = 0; speechEndedAt = 0; gen++; }
  // External resets cancel queued and in-flight finals, not just partials.
  // A reset is also the start of a press: the resident whisper comes back if it
  // went away while the Companion sat idle.
  function reset() {
    epoch++; resetSegment(); preRoll = [];
    lastPartial = { gen: -1, speechMs: 0, text: '' };
    loudSum = loudN = quietSum = quietN = 0;
    if (server) server.warm();
  }

  let finalsWaiting = 0;
  async function partial() {
    if (busy || finalsWaiting) return;
    busy = true;
    const mine = gen; const session = epoch; const ms = segMs; const spoke = speechMs; const t0 = Date.now();
    const flight = { gen: mine, speechMs: spoke, child: null, stopped: false, ctl: new AbortController(), at: t0 };
    inFlight = flight;
    try {
      // A partial that is not back in 1.2 s is stale anyway: kill it, the next one is due.
      const text = await stt(Buffer.concat(seg), ms, 1200, (child) => { flight.child = child; }, flight.ctl.signal);
      if (flight.stopped || session !== epoch) return;
      // A pause may already have queued the final. A complete local command
      // still wins immediately, and cancels that queued transcription.
      if (text && onCommand && onCommand(text, { seg: mine, heardAt: Date.now() }) === true) {
        say('[listen] early command ' + (Date.now() - t0) + 'ms "' + text + '"');
        reset(); return;
      }
      // The segment may have ended while whisper ran; its final supersedes this.
      // Recorded even when the segment has since ended: if it heard all the
      // speech there was, the final reuses it instead of running whisper again.
      if (text) lastPartial = { gen: mine, speechMs: spoke, text };
      if (mine === gen && text && onPartial) { say('[listen] partial ' + (Date.now() - t0) + 'ms "' + text + '"'); onPartial(text, { seg: mine }); }
    } finally { busy = false; if (inFlight === flight) inFlight = null; }
  }

  async function finish(reason) {
    if (speechMs < CFG.minSpeechMs) { resetSegment(); return; }
    const pcm = Buffer.concat(seg); const ms = segMs; const heardAt = speechEndedAt || Date.now();
    const mine = gen; const session = epoch; const spoke = speechMs;
    const levels = ' speech~' + Math.round(loudSum / Math.max(1, loudN)) + ' quiet~' + Math.round(quietSum / Math.max(1, quietN));
    loudSum = 0; loudN = 0; quietSum = 0; quietN = 0;
    resetSegment();
    const t0 = Date.now();
    // A partial of this segment is still running on less speech than there now
    // is: it cannot be the final, so stop it (whisper-cli) or hang up on it (the
    // resident whisper) rather than wait up to its 1.2 s budget. With a better
    // engine ready no partial can be the final, however much it heard.
    const stop = (flight) => {
      flight.stopped = true;
      if (flight.child) { try { flight.child.kill(); } catch (_) { /* already done */ } }
      flight.ctl.abort();
    };
    const stoppable = (flight) => flight && !flight.stopped && (flight.child || server);
    if (stoppable(inFlight) && inFlight.gen === mine && (inFlight.speechMs !== spoke || engineCan('ready'))) {
      stop(inFlight);
      say('[listen] stale partial stopped (' + (reason === 'flush' ? 'at key up' : reason) + ')');
    }
    // One whisper at a time, and a finished sentence goes before any partial
    // of the sentence after it. A partial that heard all of it may be the final,
    // so it gets a moment; past that the final goes on without it.
    finalsWaiting++;
    while (busy) {
      if (stoppable(inFlight) && Date.now() - inFlight.at >= CFG.slowPartialMs) stop(inFlight);
      await new Promise((r) => setTimeout(r, 25));
    }
    finalsWaiting--;
    if (session !== epoch) return;
    // Nothing was said after the last partial was cut: it already is the final.
    const whole = lastPartial.gen === mine && lastPartial.speechMs === spoke ? lastPartial.text : '';
    const reused = (note, spent) => {
      say('[listen] final ' + spent + 'ms (' + reason + ', reused partial,' + levels + ', whisper' + note + ') "' + whole + '"');
      // reason: 'pause' or 'max' means the person may still be mid-sentence;
      // 'flush' means the key came up and this is the end of what they said.
      if (onFinal) onFinal(whole, { heardAt, seg: mine, reason });
    };
    const up = engineCan('ready');
    const notUp = !up && engineCan('wanted') ? ', ' + finalEngine.name + ' not loaded' : '';
    if (whole && !up) { reused(notUp, 0); return; }
    busy = true;
    try {
      const better = up ? await betterFinal(pcm, ms) : null;
      if (session !== epoch) return;
      if (better && better.text) {
        say('[listen] final ' + (Date.now() - t0) + 'ms (' + reason + ', ' + Math.round(ms) + 'ms audio,' + levels + ', ' + finalEngine.name + ') "' + better.text + '"');
        if (onFinal) onFinal(better.text, { heardAt, seg: mine, reason });
        return;
      }
      const note = better ? ', ' + finalEngine.name + ' ' + better.why : notUp;
      if (whole) { reused(note, better ? Date.now() - t0 : 0); return; }
      const text = await stt(pcm, ms);
      if (session !== epoch) return;
      say('[listen] final ' + (Date.now() - t0) + 'ms (' + reason + ', ' + Math.round(ms) + 'ms audio,' + levels + ', whisper' + note + ') "' + text + '"');
      if (text && onFinal) onFinal(text, { heardAt, seg: mine, reason });
    } finally { busy = false; }
  }

  function push(chunk) {
    if (!found.exe || !found.model) return;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const ms = buf.length / BYTES_PER_MS;
    const level = rms16(buf);
    const loud = level >= CFG.speechRms;
    if (loud) { loudSum += level; loudN++; } else { quietSum += level; quietN++; }
    if (!seg.length) {
      if (!loud) {
        preRoll.push(buf);
        let total = preRoll.reduce((n, b) => n + b.length, 0) / BYTES_PER_MS;
        while (preRoll.length > 1 && total > CFG.preRollMs) { total -= preRoll[0].length / BYTES_PER_MS; preRoll.shift(); }
        return;
      }
      seg = preRoll.concat([]); segMs = seg.reduce((n, b) => n + b.length, 0) / BYTES_PER_MS; preRoll = [];
    }
    seg.push(buf); segMs += ms;
    if (loud) { speechMs += ms; quietMs = 0; speechEndedAt = Date.now(); } else { quietMs += ms; }
    if (quietMs >= CFG.pauseMs) { lastFinish = finish('pause').catch((e) => { say('[listen] final failed: ' + (e && e.message)); }); return; }
    if (segMs >= CFG.maxSegmentMs) { lastFinish = finish('max').catch((e) => { say('[listen] final failed: ' + (e && e.message)); }); return; }
    if (speechMs >= CFG.firstPartialMs && segMs - lastPartialAtMs >= CFG.partialEveryMs && !busy) { lastPartialAtMs = segMs; partial(); }
  }

  // The key came up, or the mic closed: whatever is buffered is the end. With
  // nothing buffered it still waits for a final that a pause started a moment
  // ago and whisper has not answered yet: until that lands the press is not
  // over (it used to return at once, and the caller, seeing no final yet, said
  // "I did not catch that" over words that arrived 200 ms later).
  let lastFinish = Promise.resolve();
  function flush() { return seg.length ? finish('flush') : lastFinish; }

  // The whole press, heard once more in one piece and with care (the resident
  // whisper's careful decode, src/whisper-server.js). The fast pass above cuts
  // the press at every pause, shrinks the encoder to each piece and takes the
  // decoder's first guess: right for a command, and the reason a dictated
  // sentence came out as "I just build a nap" with a full stop at each breath
  // (live 2026-11-20). This is how OpenWhispr hears every dictation. -> the
  // words, or '' when there is no answer worth having (no resident whisper, too
  // slow, nothing heard, or the hint list said back): the caller keeps what the
  // fast pass heard.
  // With Parakeet loaded it hears the press instead: 15 of 16 of Pranav's
  // clips at about 0.3 s against 13 or 14 at 1.3 s for the careful whisper
  // (measured 2026-11-20); the careful whisper is the fallback.
  async function whole(pcm, { budgetMs = CFG.wholeBudgetMs } = {}) {
    if (!pcm || !pcm.length) return '';
    const ms = pcm.length / BYTES_PER_MS;
    if (engineCan('ready')) {
      const session = epoch;
      const t0 = Date.now();
      let timer = null;
      try {
        const overBudget = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('over budget')), budgetMs); });
        const text = clean(await Promise.race([finalEngine.transcribe(pcm), overBudget]), ms);
        if (session !== epoch) return '';
        if (text) { say('[listen] whole press ' + (Date.now() - t0) + 'ms (' + Math.round(ms) + 'ms audio, ' + finalEngine.name + ') "' + text + '"'); return text; }
        say('[listen] whole press: ' + finalEngine.name + ' heard nothing, whisper tries');
      } catch (e) { say('[listen] whole press: ' + finalEngine.name + ' ' + String((e && e.message) || e).slice(0, 60) + ', whisper tries'); }
      finally { clearTimeout(timer); }
    }
    if (!server || server.status().state !== 'ready') return '';
    const session = epoch;
    while (busy) await new Promise((r) => setTimeout(r, 25));
    busy = true;
    try {
      const prompt = promptFor();
      const t0 = Date.now();
      const words = await server.transcribe(pcmToWav(pcm, RATE, 1), { careful: true, prompt, timeoutMs: budgetMs });
      if (words == null || session !== epoch) return '';
      const text = clean(words, ms);
      if (echoesPrompt(text, prompt)) { say('[listen] whole press: the hint list came back, not kept'); return ''; }
      say('[listen] whole press ' + (Date.now() - t0) + 'ms (' + Math.round(ms) + 'ms audio) "' + text + '"');
      return text;
    } catch (e) { say('[listen] whole press failed: ' + (e && e.message)); return ''; }
    finally { busy = false; }
  }

  return { push, flush, reset, whole, available: Boolean(found.exe && found.model), resident: () => Boolean(server && server.status().state === 'ready'), CFG };
}

module.exports = { findWhisper, createListener, audioCtxFor, collapseLoops, dropRepeatedSentences, plausible, clean, vocabularyPrompt, CFG };
