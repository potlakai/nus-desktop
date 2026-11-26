'use strict';
// The Knot's short lines: the acknowledgement it says the moment it knows
// what was asked ("On it.", "Let me look."), before any model has answered,
// and the one-word replies to small talk ("Thanks.", "Anytime."). They are
// made once with the Knot's own voice and kept as WAV files beside the voice
// model, so saying one costs a file read instead of a synthesis (0.6 s for
// "Done." on the Ryzen 7 4700U). Without the Knot's voice the system voice
// says them, which starts at once anyway.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pcmToWav } = require('../wav');

// What the Knot says while it gets going, by what it is about to do.
const ACKS = {
  open: 'On it.',             // open an app or a site
  search: 'Looking.',         // a web search
  sure: 'Sure.',              // volume, play or pause, the Knot moving or resizing
  hands: 'Sure, doing that.', // a task for Hands
  message: 'Sure, writing it.', // an email or message, through Hands
  guide: 'Let me look.',      // a walkthrough: the screen is read first
  reading: 'Okay, reading it.', // homework help, reading the page
  recall: 'Let me check.',    // a question about your own notes or chats
};
const SMALL_TALK_LINES = ['Anytime.', 'Thanks.', 'Happy to.'];
// Said the moment the talk key comes up, before anything knows what was
// asked, so the wait for the ack above is not silence. First, so it is the
// first line made.
const NEUTRAL_ACK = 'Mm.';
// Retired 2026-11-02 (Pranav: it sat in front of every reply). Not made any
// more; the name stays for the ledger's first_sound row and the tests.
const LINES = Object.values(ACKS).concat(SMALL_TALK_LINES);

// The Knot's own acknowledgements, heard back: the mic caught the Knot, or the
// person repeated it (live 2026-11-03: "After this one" fired the reflex "next").
// Never a command. "Sure." is left out, because a person says that as an answer.
const NOT_A_COMMAND = new Set(Object.values(ACKS).concat('After this one.', 'Still on the last task.').filter((l) => l !== ACKS.sure).map(plainWords));
function plainWords(s) { return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function heardBack(text) {
  const parts = String(text || '').split(/[.!?…]+/).map(plainWords).filter(Boolean);
  return parts.length > 0 && parts.every((p) => NOT_A_COMMAND.has(p));
}

// The reflex layer's intents that get an acknowledgement. Everything else it
// does is either silent and instant (a window snap) or answers for itself.
const INTENT_ACK = { open_app: 'open', open_site: 'open', web_search: 'search', volume_up: 'sure', volume_down: 'sure', mute: 'sure', play_pause: 'sure' };
function ackForIntent(intent) { return INTENT_ACK[intent] || null; }

// "Thanks", "good job", "that was fast": one line back, no model, nothing on
// the screen touched. If an ask follows ("thanks, now open Word") the small
// talk is dropped and the rest is routed as usual. -> { line, rest } or null.
const NAME = "(?:[\\s,]+(?:n[uū]s|nu's|news|knot|buddy|man|dude))?";
const LEAD = "^\\s*(?:(?:oh|ok|okay|wow|hey|yo|hmm|ah|aw|alright)[\\s,.!]+)*";
// Thanks: always small talk, comma or not.
const THANKS = '(?:thank you so much|thanks so much|thanks a lot|thank you very much|thanks a ton|much appreciated|i appreciate (?:it|that)|appreciate (?:it|that)|thank you|thanks|thx|ty|cheers)';
// Praise that cannot be the start of an ask.
const PRAISE = "(?:good job|great job|nice job|nice work|good work|great work|well done|nicely done|good stuff|you(?:'re| are) the best|you(?:'re| are) awesome|you(?:'re| are) amazing|you rock|love it|love that|that was (?:so |really |pretty |super |very )?(?:fast|quick|good|great|awesome|amazing|nice|cool|perfect|sick)|that(?:'s| is) (?:so |really |pretty |super )?(?:fast|quick|good|great|awesome|amazing|perfect|cool|sick)|so (?:fast|quick))";
// One word that could also open an ask ("perfect the essay"): only when
// nothing follows, or a full stop or comma does.
const SHORT = '(?:nice(?: one)?|perfect|awesome|amazing|great|sweet|cool|sick|wow|beautiful|lovely|brilliant|excellent)';
const END = '[\\s,.!?]*';
const SMALL_TALK_RE = [
  ['thanks', new RegExp(LEAD + '(' + THANKS + ')' + NAME + '(?:[\\s,.!?]+|$)(.*)$', 'i')],
  ['praise', new RegExp(LEAD + '(' + PRAISE + ')' + NAME + '(?:[\\s,.!?]+|$)(.*)$', 'i')],
  ['praise', new RegExp(LEAD + '(' + SHORT + ')' + NAME + '(?:' + END + '$|[,.!?]+\\s*(.*)$)', 'i')],
];
function lineFor(kind, phrase) {
  if (kind === 'thanks') return /so much|a lot|very much|a ton|appreciate/i.test(phrase) ? 'Happy to.' : 'Anytime.';
  return 'Thanks.';
}
function smallTalk(text) {
  let t = String(text || '').trim();
  if (!t || t.length > 200) return null;
  const hits = [];
  // "Perfect, thank you." is one bit of small talk; peel each one off.
  for (let guard = 0; guard < 4 && t; guard++) {
    let hit = null;
    for (const [kind, re] of SMALL_TALK_RE) { const m = re.exec(t); if (m) { hit = { kind, phrase: m[1], rest: String(m[2] || '').trim() }; break; } }
    if (!hit) break;
    hits.push(hit);
    t = hit.rest;
  }
  if (!hits.length) return null;
  // Thanks anywhere in it gets the answer to thanks ("Perfect, thank you" -> "Anytime.").
  const said = hits.find((h) => h.kind === 'thanks') || hits[0];
  let rest = t.replace(/^(?:(?:and|so|now|also|then|but)[\s,]+)+/i, '').trim();
  // "Good job on the outline" is still praise, not an ask.
  if (/^(?:on|with|for|at|in|there|today|again|guys|everyone)\b/i.test(rest)) rest = '';
  // A stray word or two left over ("thanks Nūs buddy") is not an ask.
  const words = rest.split(/\s+/).filter((w) => /[a-z0-9]/i.test(w));
  return { line: lineFor(said.kind, said.phrase), rest: words.length >= 2 ? rest : '' };
}

// The cache. voiceKey names the voice that made a line (voice, speaker,
// speed): a different voice makes its own files. synth(line) -> { sampleRate,
// pcm (Buffer of Int16 LE), ms, secs }.
function readWav(buf) {
  if (!buf || buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
  const sampleRate = buf.readUInt32LE(24);
  const size = buf.readUInt32LE(40);
  const pcm = buf.subarray(44, 44 + Math.min(size, buf.length - 44));
  if (!sampleRate || !pcm.length) return null;
  return { sampleRate, pcm: Buffer.from(pcm), secs: pcm.length / 2 / sampleRate };
}
function fileName(voiceKey, line) {
  const slug = String(line).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'line';
  return slug + '-' + crypto.createHash('sha1').update(String(voiceKey) + '\n' + line).digest('hex').slice(0, 10) + '.wav';
}

// How many times in a row one line may be cut off by live speech before the
// making stops for now, and how often it looks to see if the coast is clear.
const MAX_STOPS = 5;
const QUIET_POLL_MS = 150;

// quiet(): nothing live needs the voice or the CPU right now (making waits for it).
// shipped: a folder of lines made when the app was built (scripts/make-voice-lines.js, 0.1.33),
// named exactly as this cache names them, so a line for the same voice is found there and is
// never made on the person's computer. Measured 2026-11-21 on a new profile: making the 49 fixed
// lines kept the voice worker at about 3.7 processor cores from roughly 50 to 80 s after the
// first start, while a new person was on the tour and asking their first questions. A line that
// is not shipped (another voice, the greeting with a name, a line added later) is made as before.
function createLineCache({ dir, shipped, voiceKey, synth, log = () => {}, keep = (line) => LINES.includes(line), quiet = () => true, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const mem = new Map();          // key -> { sampleRate, pcm, secs }
  let rendering = null;
  let queue = [];
  const asked = new Set();
  const key = (line) => voiceKey() + '\n' + line;
  function file(line) { return path.join(dir, fileName(voiceKey(), line)); }
  // The shipped folder is listed once: has() is asked for every line at start and on every tour
  // card and must not touch the disk each time (see has below).
  let shippedNames = null;
  function shippedFile(line) {
    if (!shipped) return null;
    if (!shippedNames) { try { shippedNames = new Set(fs.readdirSync(shipped)); } catch (_) { shippedNames = new Set(); } }
    const name = fileName(voiceKey(), line);
    return shippedNames.has(name) ? path.join(shipped, name) : null;
  }

  // A line already made -> its audio, else null. Never synthesizes.
  function get(line) {
    const k = voiceKey();
    if (!k || !line) return null;
    const hit = mem.get(key(line));
    if (hit) return hit;
    try {
      const a = readWav(fs.readFileSync(file(line)));
      if (a) { mem.set(key(line), a); return a; }
    } catch (_) { /* not made yet */ }
    const sf = shippedFile(line);
    if (sf) {
      try {
        const a = readWav(fs.readFileSync(sf));
        if (a) { mem.set(key(line), a); return a; }
      } catch (_) { /* unreadable: made here instead */ }
      shippedNames.delete(path.basename(sf));   // a broken shipped file is not offered again
    }
    return null;
  }
  // Keep a line just made, if it is one worth keeping.
  function put(line, audio) {
    const k = voiceKey();
    if (!k || !audio || !audio.pcm || !keep(line)) return false;
    const a = { sampleRate: audio.sampleRate, pcm: Buffer.from(audio.pcm), secs: audio.secs || audio.pcm.length / 2 / audio.sampleRate };
    mem.set(key(line), a);
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file(line), pcmToWav(a.pcm, a.sampleRate)); } catch (e) { log('line not saved: ' + e.message); }
    return true;
  }
  // Is a line made already? Asked for every line at start and on every tour card, so it must
  // not read the audio, or even open the files: reading all of them held the main thread for
  // 150 ms (the short lines) to 730 ms (the tour's), measured 2026-11-11 with the lag recorder,
  // and opening each one still cost about a millisecond apiece. One look at the file's size is
  // enough: a line cut short by a crash is empty or tiny and is made again; anything else wrong
  // with a file shows when the line is said, and saying it makes it again.
  function has(line) {
    const k = voiceKey();
    if (!k || !line) return false;
    if (mem.has(key(line))) return true;
    if (shippedFile(line)) return true;         // made at build time: one set lookup, no disk
    try { return fs.statSync(file(line)).size > 44; } catch (_) { return false; }
  }
  function missing(lines = LINES) { return lines.filter((l) => !has(l)); }
  // Make every line that is not there yet, one at a time, behind live speech.
  // Live speech stops the voice, which cuts off the line being made (voice.stop,
  // and live 2026-11-03: every tour card did it, "0 made, 38 left"), so that line
  // is made again once it is quiet. The newest ask goes first: the tour's next
  // cards ahead of a list started at install.
  function prerender(lines = LINES) {
    if (!voiceKey()) return Promise.resolve({ made: 0, left: lines.length });
    for (const l of lines) asked.add(l);
    queue = [...missing(lines), ...queue.filter((l) => !lines.includes(l))];
    if (rendering) return rendering;
    rendering = (async () => {
      const k = voiceKey();
      let made = 0, stops = 0;
      while (queue.length && voiceKey() === k) {
        if (!quiet()) { await sleep(QUIET_POLL_MS); continue; }
        const line = queue[0];
        try {
          // It may have been said live and kept in the meantime.
          if (!get(line)) { const a = await synth(line); if (put(line, a)) made++; }
          stops = 0;
          queue = queue.filter((l) => l !== line);
        } catch (e) {
          if (e.message === 'stopped' && ++stops <= MAX_STOPS) continue;
          log('line "' + line + '" not made: ' + e.message);
          break;
        }
      }
      queue = [];
      const left = missing([...asked]).length;
      asked.clear();
      log('lines ready: ' + made + ' made, ' + left + ' left');
      return { made, left };
    })().finally(() => { rendering = null; });
    return rendering;
  }
  // The app is going away: no more lines, and no voice model reloaded for one.
  function cancel() { queue = []; }
  return { get, put, has, missing, prerender, cancel, file };
}

// Where the lines made at build time sit: resources/voice-lines in the installed app
// (electron-builder.companion.config.js copies vendor/voice-lines there), vendor/voice-lines in a
// run from source. The first folder that exists, or '' when there is none.
function shippedLinesDir(resourcesPath = process.resourcesPath, exists = fs.existsSync) {
  const roots = [];
  if (resourcesPath) roots.push(path.join(resourcesPath, 'voice-lines'));
  roots.push(path.join(__dirname, '..', '..', '..', 'vendor', 'voice-lines'));
  for (const r of roots) { try { if (exists(r)) return r; } catch (_) { /* next */ } }
  return '';
}

// The name of the voice that made a line, as the cache keys it. One place, so the build script
// and the app cannot drift apart: a different key means the shipped files are never found.
function voiceKeyOf(voiceName, v) { return v ? [voiceName, v.model, v.speaker, v.speed].join(':') : ''; }

module.exports = { ACKS, NEUTRAL_ACK, SMALL_TALK_LINES, LINES, ackForIntent, heardBack, smallTalk, createLineCache, readWav, fileName, shippedLinesDir, voiceKeyOf };
