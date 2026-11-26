/* Nūs Companion renderer: UI state, mic capture, IPC, streaming render. */
(function () {
  const { icon } = window.ICONS;
  const nus = window.nus || createPreviewBridge(); // preload in Electron, local visual fixture in a browser
  const $ = (s) => document.querySelector(s);
  const cmdKey = nus.platform === 'darwin' ? '⌘' : 'Ctrl';
  const isCmdOrCtrl = (e) => nus.platform === 'darwin' ? e.metaKey : e.ctrlKey;
  const DEFAULT_ASSIST_SHORTCUT = 'CommandOrControl+Return';

  // ---- paint icons -------------------------------------------------------
  $('#logo-btn').innerHTML = icon('logo', { size: 18 });
  $('#stop-btn').innerHTML = icon('stop-square', { size: 15 });
  // Driven by data-icon so adding a mode button needs no change here.
  document.querySelectorAll('.act[data-icon]').forEach((btn) => {
    const slot = btn.querySelector('.ic');
    if (slot) slot.innerHTML = icon(btn.dataset.icon, { size: 16 });
  });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let standalone = false;
  let busy = false;
  let guideState = null;  // main-owned guide session state, null outside a session
  let quickOpen = false;  // the one-line quick ask by the Knot
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let assistShortcut = DEFAULT_ASSIST_SHORTCUT;
  let recordingShortcut = false;
  let ackUntil = 0;        // local "working" until main's first state after an ask
  let ackTimer = null;
  let fileDragActive = false; // a file is being dragged over the window (drop on the Knot)
  let workTimers = [];     // "still working" hints while a working state persists
  let errorUp = false;     // an error bubble is on screen
  const cues = window.NusCues || { play() {}, setEnabled() {}, setGate() {}, quiet() {} };
  // Every number the Knot uses lives in knot-spec.js.
  const KSPEC = window.NusKnotSpec || { host: { ackGapMs: 300, speedFirst: true, preReachDelayMs: 350, sleepAfterMs: 90000, clampMargin: 40, skater: { minDistance: 80 }, acrobat: { minWidth: 320, minHeight: 200 } }, inline: { surface: { offsetX: 44, offsetY: 56, anchorInset: 16 }, lean: {} }, moves: { tap: .18 }, surfaces: { open: .32 } };

  // Within a frame of any ask: the body reacts, a tone answers, and the Knot
  // reads as working until main says otherwise. This is the single most
  // important gesture: it is what "it heard me" feels like.
  let lastAckAt = 0;
  function ack(opts) {
    holdWorking();
    lastAckAt = Date.now();
    if (knot3d && knot3d.gesture) knot3d.gesture('acknowledge');
    // At key up the release pop is the only sound until the spoken ack.
    if (!(opts && opts.silent)) cues.play('ack');
  }
  // The local "working" beat on its own, for the moments that already have a
  // gesture of their own (a dropped file gulps; it does not also acknowledge).
  function holdWorking() {
    ackUntil = Date.now() + 2500;
    clearTimeout(ackTimer);
    ackTimer = setTimeout(() => { syncKnotUi(); syncSlot(); }, 2600);
    syncKnotUi();
  }
  // An ask that main started (a hotkey, select-and-ask, a verb button) never
  // passed through ack(). It still gets the gesture, once, on its first sign of work.
  function ensureAck() {
    if (Date.now() - lastAckAt < KSPEC.host.ackGapMs) return;
    lastAckAt = Date.now();
    if (knot3d && knot3d.gesture) knot3d.gesture('acknowledge');
    cues.play('ack');
  }
  // The error beat: the shake, the two falling notes, and a breath of the
  // error accent on the mark (the engine fades it in and out with the gesture).
  function errorBeat() {
    cues.play('error');
    if (knot3d && knot3d.gesture) knot3d.gesture('error');
  }
  function clearAck() { ackUntil = 0; clearTimeout(ackTimer); ackTimer = null; }
  // Never silent: a working state that lasts says so, then says it is slow.
  function watchWork(state) {
    workTimers.forEach(clearTimeout); workTimers = [];
    if (!['reading', 'thinking', 'transcribing', 'unwinding'].includes(state)) return;
    workTimers = [
      setTimeout(() => showHint({ text: 'Still working…', ms: 4000 }), 6000),
      setTimeout(() => showHint({ text: 'Taking longer than usual', ms: 5000 }), 20000),
    ];
  }

  const messages = $('#messages');
  nus.on('settings:changed', s => {
    if (!standalone) return;
    settings = s;
    assistShortcut = s.shortcuts?.assist || DEFAULT_ASSIST_SHORTCUT;
    cues.setEnabled(s.sounds !== false);
    syncAssistShortcutLabels();
    if (isShown($('#settings-scrim'))) fillSettings();
  });

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function shortcutParts(accelerator) {
    const labels = {
      CommandOrControl: nus.platform === 'darwin' ? '⌘' : 'Ctrl',
      Command: '⌘', Control: nus.platform === 'darwin' ? '⌃' : 'Ctrl', Super: 'Super',
      Alt: nus.platform === 'darwin' ? '⌥' : 'Alt',
      Shift: nus.platform === 'darwin' ? '⇧' : 'Shift',
      Return: 'Enter', Escape: 'Esc', Space: 'Space',
      Up: '↑', Down: '↓', Left: '←', Right: '→'
    };
    return (accelerator || DEFAULT_ASSIST_SHORTCUT).split('+').map((part) => labels[part] || part);
  }

  function shortcutKeycapsHtml(accelerator, className) {
    const cls = className || 'keycap';
    return shortcutParts(accelerator).map((part) => '<span class="' + cls + '">' + esc(part) + '</span>').join(' ');
  }

  function syncAssistShortcutLabels() {
    const shortcutBtn = $('#shortcut-assist');
    if (shortcutBtn && !recordingShortcut) shortcutBtn.textContent = shortcutParts(assistShortcut).join(' + ');
    const placeholder = $('#placeholder');
    if (standalone && placeholder) { placeholder.textContent = 'Ask Nūs anything, or hold the talk key'; return; }
    if (placeholder) placeholder.innerHTML = 'Ask Nūs anything, or ' + shortcutKeycapsHtml(assistShortcut) + ' for What should I do?';
  }

  // minimal, safe markdown: fenced code, bullets, inline code, bold, paragraphs
  function renderMarkdown(text) {
    const lines = text.split('\n');
    let html = '', inCode = false, inList = false, buf = [];
    const flushP = () => { if (buf.length) { html += '<p>' + inline(buf.join(' ')) + '</p>'; buf = []; } };
    const inline = (s) => esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    for (const raw of lines) {
      const line = raw;
      if (/^```/.test(line.trim())) {
        if (!inCode) { flushP(); if (inList) { html += '</ul>'; inList = false; } html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += esc(line) + '\n'; continue; }
      if (/^\s*[-*]\s+/.test(line)) { flushP(); if (!inList) { html += '<ul>'; inList = true; } html += '<li>' + inline(line.replace(/^\s*[-*]\s+/, '')) + '</li>'; continue; }
      if (line.trim() === '') { flushP(); if (inList) { html += '</ul>'; inList = false; } continue; }
      buf.push(line.trim());
    }
    flushP(); if (inList) html += '</ul>'; if (inCode) html += '</code></pre>';
    return html;
  }

  function clearMessages() { messages.innerHTML = ''; aiEl = null; caretEl = null; }

  function addUserBubble(text) {
    const b = document.createElement('div');
    b.className = 'user-bubble';
    b.textContent = text;
    messages.appendChild(b);
  }

  function startAi(small) {
    aiEl = document.createElement('div');
    aiEl.className = 'ai-text' + (small ? ' small' : '');
    aiEl.dataset.raw = '';
    caretEl = document.createElement('span');
    caretEl.className = 'ai-caret';
    aiEl.appendChild(caretEl);
    messages.appendChild(aiEl);
  }

  // Streaming paints the markdown as it grows, once per frame, so the final
  // render is the same DOM and nothing jumps when the answer completes. The
  // old per-token spans were swapped for markdown at the end, which read as
  // the whole answer flinching.
  let paintRaf = null, paintedLen = -1;
  function paintAi() {
    paintRaf = null;
    if (!aiEl) return;
    const raw = aiEl.dataset.raw || '';
    if (raw.length === paintedLen) return;
    paintedLen = raw.length;
    aiEl.innerHTML = renderMarkdown(raw);
    if (caretEl) aiEl.appendChild(caretEl);
  }
  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    if (!paintRaf) paintRaf = requestAnimationFrame(paintAi);
  }

  function finalizeAi() {
    if (!aiEl) return '';
    if (paintRaf) { cancelAnimationFrame(paintRaf); paintRaf = null; }
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null; paintedLen = -1;
    return raw;
  }

  // Click-through state. It lives up here, above every caller, because the
  // window's real ignore state and this variable must never diverge: a direct
  // setIgnoreMouse call that skipped this left `ignoring` stale, and then the
  // equality guard swallowed the very call that makes the overlay clickable
  // again. One setter, one state, no way back into that.
  let ignoring = null;
  // Island mode: the Knot docked at the left end of a black pill at the top
  // centre of the screen (design/island-2026-10-19). Off = the free Knot.
  let islandOn = false;
  // The free Knot's pill, and whether the pill's code below has loaded yet: the
  // Knot's state is first set while this file is still running.
  let pillFree = false, pillReady = false;
  function setIgnoreSafe(v) {
    if (v === ignoring) return;
    ignoring = v;
    try { nus.setIgnoreMouse(v); } catch (_) { /* preload stub */ }
    if (v === false) noteMouseTaken();
  }

  // The 3D knot canvas. Falls back to the inline SVG when canvas is missing.
  // ground:false + a smaller scale: the mark floats shadow-free on the user's
  // desktop, and the extra canvas margin keeps its glow from being cut off.
  // focusGate:false: the overlay is shown inactive by design, so the Knot
  // must not drop to a third of its frame rate for never being focused.
  // The Knot and its one thread are one engine (knot-engine.js): the approved
  // motion design, driven from here through two handles.
  const engine = window.NusKnotEngine ? NusKnotEngine.mount({ body: $('#knot-canvas'), thread: $('#strand-layer') }) : null;
  const knot3d = engine ? engine.knot : null;
  if (knot3d) $('#orb').classList.add('k3d');
  // A read-only handle for DevTools and the CDP checks (verify-polish.cjs):
  // the page is sandboxed and same-origin only, so nothing else can reach it.
  window.__nusKnot = knot3d;
  // The same for the motion checks (verify-motion.cjs): the thread, and the
  // renderer's own handlers so a check can play a guide step the way main would.
  window.__nusMotion = { intro: () => playIntro(), knot: knot3d, get thread() { return strand; }, target: (p) => onGuideTarget(p), bubble: (p) => onGuideBubble(p), done: (p) => onGuideDone(p), state: (s, t) => setGuideState(s, t), dismiss: (r) => dismissGuide(r), hint: (p) => showHint(p), ask: () => openQuickAsk(), closeAsk: () => closeQuickAsk(), move: (to, o) => moveKnotTo(to, o), place: (p) => applyKnotPos(p), where: () => (knotPos ? { x: knotPos.x, y: knotPos.y } : null), cues };
  // The focus guard's glow: 'active' (coral) while it keeps the feeds shut,
  // 'done' (green) for a beat when it lets go, null otherwise. Declared up here
  // because syncKnotUi reads it from the first paint on.
  let guardGlow = null;
  // The game (play.js), made further down once the Knot's layout exists.
  let play = null;
  // The tour's card now up (declared early for the same reason: the Knot holds
  // its attentive state while one is).
  let tourCard = null;
  // While the Knot flies to or from the island the sheet holds still, then glides.
  let tourIslandWant = null, tourHomeHold = null;
  // The "circle it" ring and the rect it goes around (declared early: endGuide reads them).
  let circleEl = null, circleTimer = null, lastTargetRect = null;

  function syncKnotUi() {
    const toolbar = $('#toolbar');
    const panelNode = $('#panel');
    const listening = $('#stop-btn').classList.contains('active');
    const panelOpen = panelNode && !panelNode.classList.contains('collapsed');
    // A guide session (main-owned) outranks the local state ladder. Thread
    // colour = task; the Knot's glow = this state.
    // Four different bodies on the way to an answer: listening (orchid, loose),
    // transcribing (working: amber, spinning), reading (blue, leaning),
    // thinking (tight, fastest). They used to collapse into two.
    const GUIDE_KNOT = { listening: 'listening', transcribing: 'working', reading: 'reading', thinking: 'thinking', unwinding: 'ready', pointing: 'ready', nudging: 'ready', explaining: 'ready', keeping: 'thinking', done: 'ready', winding: 'idle' };
    // A local acknowledgement holds "working" for the beat between an ask and
    // main's first state, so the Knot never sits silent after Enter.
    const acking = Date.now() < ackUntil;
    const state = guideState ? (guideState === 'winding' && tourCard ? 'ready' : GUIDE_KNOT[guideState] || 'ready') : (busy || acking) ? 'thinking' : listening ? 'listening' : (panelOpen || quickOpen || tourCard) ? 'ready' : 'idle';
    const copy = (guideState && {
      listening: ['Nūs listening', 'Release to send'],
      transcribing: ['Nūs working', 'Got it, one moment'],
      reading: ['Nūs reading your screen', 'Blue means looking'],
      unwinding: ['Nūs unwinding', 'Following the thread'],
      pointing: ['Nūs pointing', 'Esc or click me to wind back'],
      nudging: ['Nūs has a note', 'Not now snoozes it for today'],
      explaining: ['Nūs answering', 'Esc or click me to close'],
      keeping: ['Nūs keeping that', 'Stored for later'],
      done: ['Nūs done', 'Winding back'],
    }[guideState]) || {
      idle: ['Nūs idle', 'Quietly available'],
      listening: ['Nūs listening', 'Screen + voice active'],
      thinking: ['Nūs thinking', 'Working through context'],
      ready: ['Nūs ready', 'Command layer open']
    }[state];

    toolbar.dataset.knotState = state;
    toolbar.classList.toggle('panel-open', !!panelOpen);
    $('#orb').setAttribute('aria-expanded', String(!!panelOpen));
    $('#knot-status-title').textContent = copy[0];
    $('#knot-status-subtitle').textContent = copy[1];
    if (knot3d) {
      // The body the Knot wears. Work in progress outranks everything; at rest
      // an error bubble shows as the error body and speech as the speaking one.
      // (The engine leans it toward the screen while reading and toward the
      // target while pointing; nothing here sets a pose.)
      let body = guideState === 'reading' ? 'reading' : ($('#orb').classList.contains('spar') && !busy ? 'spar' : state);
      if (body === 'idle' || body === 'ready') body = errorUp ? 'error' : speakingNow ? 'speaking' : body;
      // At rest the accent barely shows; while the guard is on the Knot wears
      // the ready body so its coral (or green) is actually visible.
      if (body === 'idle' && guardGlow) body = 'ready';
      knot3d.setState(body);
    }
    syncIsland(state);
    // Play never runs under a task: a guide step, an answer on its way or the mic
    // open ends the game on the spot.
    if (play && play.active && (guideState || busy || acking || listening)) stopPlay('task');
    if (state !== 'idle') noteActivity();
  }

  // ---- sleep and wake ------------------------------------------------------
  // Ninety seconds with nothing open and nothing happening: the Knot settles
  // into a slow breath and the render loop stops. A hover, a state change or
  // an ask wakes it. This is where the idle CPU went.
  const IDLE_SLEEP_MS = KSPEC.host.sleepAfterMs;
  let sleepTimer = null;
  function armSleep() { clearTimeout(sleepTimer); sleepTimer = setTimeout(maybeSleep, IDLE_SLEEP_MS); }
  function noteActivity() {
    if (knot3d && knot3d.isSleeping && knot3d.isSleeping()) { knot3d.wake(); cues.play('wake'); }
    armSleep();
  }
  function maybeSleep() {
    if (!knot3d || !knot3d.sleep) return;
    const quiet = !guideState && !busy && !quickOpen && !pttHeld && !captureOn() && !modalOpen() && !speakingNow && !dragging && !(play && play.active)
      && !isShown(panel, 'collapsed') && !isShown(bubble) && !isShown(knotHint) && !isShown(keepChip) && !isShown($('#tour'))
      && !(strand && strand.isOut()) && !(knot3d.isTravelling && knot3d.isTravelling());
    if (!quiet) { armSleep(); return; }
    knot3d.sleep();
    cues.play('sleep');
  }
  $('#knot-shell').addEventListener('pointerenter', noteActivity);
  armSleep();

  function setBusy(v) {
    busy = v;
    $('#send-btn').classList.toggle('busy', v);
    $('#orb').classList.toggle('busy', v);
    syncKnotUi();
  }

  // ---- tiles -------------------------------------------------------------
  // Tiles are hidden by default: the Knot is the whole UI until something needs
  // to be shown. Any response, status, or Knot click materializes them.
  // Ctrl+Shift+K: hide/show just the Knot mark. Everything else keeps working.
  // The main process owns the state (persisted), so this is an idempotent set.
  nus.on('knot:set', (p) => { document.getElementById('toolbar').classList.toggle('knot-hidden', !!(p && p.hidden)); });

  const panel = $('#panel');
  // Surfaces enter with a spring and leave with a fast ease (surface.js).
  // "Is it showing" is always isShown(): an element on its way out has the
  // hidden class removed but must not count as visible.
  const { showSurface, hideSurface, isShown, reveal, leaveMs } = window.NusSurface || { showSurface: (el) => el && el.classList.remove('hidden'), hideSurface: (el, done) => { if (el) el.classList.add('hidden'); if (done) done(); }, isShown: (el) => !!el && !el.classList.contains('hidden'), reveal() {}, leaveMs: () => 0 };
  function showTiles() { showSurface(panel, null, 'collapsed'); syncKnotUi(); }
  function hideTiles() { hideSurface(panel, null, 'collapsed'); syncKnotUi(); }
  function toggleTiles() { if (isShown(panel, 'collapsed')) hideTiles(); else showTiles(); }
  // Standalone: an answered sheet folds itself away after 20 s without a touch,
  // so the Knot goes back to being the whole UI. Any pointer or key inside the
  // sheet restarts the clock; a composer with focus never closes underneath you.
  let sheetCloseTimer = null;
  function scheduleSheetClose() {
    if (!standalone) return;
    clearTimeout(sheetCloseTimer);
    sheetCloseTimer = setTimeout(() => {
      sheetCloseTimer = null;
      if (document.activeElement === $('#input') || !isShown(panel, 'collapsed')) return;
      hideTiles();
    }, 20000);
  }
  panel.addEventListener('pointerdown', () => { if (sheetCloseTimer) scheduleSheetClose(); });
  panel.addEventListener('keydown', () => { if (sheetCloseTimer) scheduleSheetClose(); });

  // ---- speech out --------------------------------------------------------
  // Lifted from the Nūs dashboard: Edge's neural voices are free and good
  // enough, so there is no paid TTS in the loop. Used for rehearsal, where the
  // point is to practise replying out loud rather than reading.
  let voice = null;
  function pickVoice() {
    const vs = speechSynthesis.getVoices().filter((v) => v.lang.startsWith('en'));
    voice = vs.find((v) => /Natural/i.test(v.name) && /Guy|Andrew|Brian|Christopher|Ryan/i.test(v.name))
         || vs.find((v) => /Natural|Online/i.test(v.name)) || vs[0] || null;
  }
  speechSynthesis.onvoiceschanged = pickVoice;
  pickVoice();

  // What the voice is handed (speakable.js): maths, links and markdown as
  // words. The old symbol strip stays as the fallback if that file is missing.
  function plainify(text) {
    if (window.NusSpeakable) return window.NusSpeakable.speakable(text);
    return text.replace(/```[\s\S]*?```/g, ' code block omitted ')
               .replace(/[#*_`>[\]]/g, '')
               .replace(/\(https?:[^)]+\)/g, '');
  }

  let companionVoiceEnabled = true;
  // The Knot wears its speaking body for as long as an utterance is sounding.
  // The speech engine gives no audio level, so the pulse is the synthetic one;
  // start and end come from the utterance's own events. A cancel fires `error`,
  // not `end`, and some voices fire neither, hence both handlers and a timer.
  let speakingNow = false, speakWatch = null;
  function setSpeaking(on) {
    clearTimeout(speakWatch); speakWatch = null;
    if (speakingNow === on) return;
    speakingNow = on;
    if (on && typeof trMark === 'function') trMark('speech');
    syncKnotUi();
  }
  function trackSpeech(u, chars) {
    u.onstart = () => { setSpeaking(true); speakWatch = setTimeout(() => setSpeaking(false), 4000 + chars * 90); };
    u.onend = () => setSpeaking(false);
    u.onerror = () => setSpeaking(false);
    return u;
  }
  function speak(text) {
    if (!companionVoiceEnabled || pttHeld) return;
    if (!settings || !settings.speakReplies || !text) return;
    speechSynthesis.cancel();
    const plain = plainify(text).slice(0, 2200);
    if (!plain.trim()) return;
    const u = trackSpeech(new SpeechSynthesisUtterance(plain), plain.length);
    if (voice) u.voice = voice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  // ---- marks: what an answer draws on the screen (marks.js, 0.1.38) --------
  // Main places each mark and sends its rectangle. By voice a mark carries the
  // number of the sentence it belongs to and waits here until that sentence
  // starts to play; typed, or once its sentence has begun, it is drawn at once.
  const marksLayer = typeof window !== 'undefined' && window.NusMarks ? window.NusMarks.createLayer(document, { reduced: () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) }) : null;
  const marksWaiting = new Map();   // sentence key -> marks waiting for it to be spoken
  const sayWaiting = new Set();     // sentence keys queued for the voice, not yet started
  const markRect = (r) => { const z = Math.pow(1.2, (nus.getZoomLevel && nus.getZoomLevel()) || 0); return r ? { x: r.x / z, y: r.y / z, w: r.w / z, h: r.h / z } : null; };
  function drawMarks(list) {
    if (!marksLayer) return;
    for (const m of list || []) {
      if (!m) continue;
      marksLayer.draw(m.shape === 'arrow' ? { shape: 'arrow', from: markRect(m.from), to: markRect(m.to), verified: m.verified, light: !!m.light, bow: m.bow } : { shape: m.shape, rects: (m.rects || []).map(markRect), verified: m.verified, light: !!m.light, fix: m.fix, above: !!m.above });
    }
  }
  // A sentence began to play (or will never be played): its marks go down now.
  function sentenceStarted(key) {
    if (key == null) return;
    sayWaiting.delete(key);
    const waiting = marksWaiting.get(key);
    if (waiting) { marksWaiting.delete(key); drawMarks(waiting); }
  }
  // The voice was cut off: what was waiting for a sentence is drawn without it.
  function releaseMarks() { sayWaiting.clear(); for (const list of marksWaiting.values()) drawMarks(list); marksWaiting.clear(); }
  function clearMarks(fast) { sayWaiting.clear(); marksWaiting.clear(); if (marksLayer) marksLayer.clear(!!fast); }
  nus.on('guide:marks', (p) => {
    if (!p || !Array.isArray(p.marks) || !p.marks.length) return;
    const key = p.sid != null ? String(p.sessionId || '') + ':' + p.sid : null;
    if (key == null || !sayWaiting.has(key)) { drawMarks(p.marks); return; }
    marksWaiting.set(key, (marksWaiting.get(key) || []).concat(p.marks));
  });
  nus.on('guide:marks:clear', () => clearMarks(false));

  function stopSpeaking() {
    releaseMarks();
    sayQueue.length = 0; sayBusy = false; voiceGen++;
    try { speechSynthesis.cancel(); } catch (_) {}
    if (voiceSource) { try { voiceSource.stop(); } catch (_) {} voiceSource = null; }
    if (nus.voiceStop) nus.voiceStop();
    if (speakingNow) setSpeaking(false);
  }

  // The guide's spoken lines. Not gated on speakReplies: main only sends
  // `speak` when the user asked by voice, and never otherwise.
  //
  // A reply arrives sentence by sentence while the model is still writing
  // (guide:say), so lines queue: sentence two waits for sentence one instead
  // of cutting it off. A new step (say with {restart:true}, the default for a
  // target or bubble) clears the queue first. Interrupting (PTT) cancels all.
  const sayQueue = [];
  let sayBusy = false;
  // The Knot's own voice (main: src/voice): main says whether it is ready;
  // each line is sent off to be made and comes back as samples, played here
  // in order through Web Audio. The next line is being made while this one
  // plays. When the voice is off or not installed, the system voice speaks.
  let ownVoice = { ready: false };
  let voiceCtx = null, voiceGen = 0, voiceSource = null;
  nus.on('voice:state', (s) => { ownVoice = s || { ready: false }; });
  // On battery the Knot's breathing states draw at the rest rate (knot-engine.js).
  nus.on('power:state', (p) => { if (knot3d && knot3d.setLowPower) knot3d.setLowPower(!!(p && p.battery)); });
  // "Stop" / "I got it from here": quiet at once, mid-word.
  nus.on('voice:hush', () => stopSpeaking());
  function speakSystem(line) {
    const u = trackSpeech(new SpeechSynthesisUtterance(line), line.length);
    if (voice) u.voice = voice;
    u.rate = 1.05;
    const onEnd = u.onend, onError = u.onerror;
    const done = () => { sayBusy = false; sayNext(); };
    u.onend = () => { if (onEnd) onEnd(); done(); };
    u.onerror = () => { if (onError) onError(); done(); };
    sayBusy = true;
    speechSynthesis.speak(u);
  }
  // sid: the sentence this audio is, so its marks are drawn as it starts.
  function playPcm(audio, gen, sid) {
    sentenceStarted(sid);
    // No pinned rate: the buffer carries its own and Web Audio resamples it.
    // A context closed by a dead audio service is replaced, not reused.
    if (!voiceCtx || voiceCtx.state === 'closed') voiceCtx = new AudioContext();
    const i16 = new Int16Array(audio.pcm);
    if (!i16.length || gen !== voiceGen) { sayBusy = false; sayNext(); return; }
    const buf = voiceCtx.createBuffer(1, i16.length, audio.sampleRate || 24000);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < i16.length; i++) ch[i] = i16[i] / 32768;
    const src = voiceCtx.createBufferSource();
    src.buffer = buf; src.connect(voiceCtx.destination);
    voiceSource = src;
    setSpeaking(true);
    speakWatch = setTimeout(() => setSpeaking(false), buf.duration * 1000 + 400);
    src.onended = () => { if (voiceSource === src) voiceSource = null; setSpeaking(false); sayBusy = false; sayNext(); };
    if (voiceCtx.state === 'suspended') voiceCtx.resume().catch(() => {});
    src.start();
  }
  function sayNext() {
    if (sayBusy || !sayQueue.length) return;
    const item = sayQueue.shift();
    sayBusy = true;
    try {
      if (item.own) {
        const gen = voiceGen;
        // Already made (it was queued while the line before it played), or make it now.
        (item.audio ? Promise.resolve(item.audio) : item.promise || nus.voiceSay(item.line)).then((audio) => { if (gen !== voiceGen) { sayBusy = false; sayNext(); return; } if (!audio) throw new Error('no audio'); if (item.first) vlog('voice: said in Fable: "' + item.line.slice(0, 40) + '"'); playPcm(audio, gen, item.sid); }).catch(() => { if (gen !== voiceGen) { sayBusy = false; sayNext(); return; } if (item.first) vlog('voice: said in the Windows voice (Fable failed): "' + item.line.slice(0, 40) + '"'); sentenceStarted(item.sid); speakSystem(item.line); });
        // Make the next line ahead while this one plays.
        const next = sayQueue[0];
        if (next && next.own && !next.promise) next.promise = nus.voiceSay(next.line).then((a) => { next.audio = a; return a; });
      } else { if (item.first) vlog('voice: said in the Windows voice (' + (ownVoice && ownVoice.installed ? 'Fable not ready' : 'Fable not installed') + '): "' + item.line.slice(0, 40) + '"'); sentenceStarted(item.sid); speakSystem(item.line); }
    } catch (_) { sayBusy = false; sentenceStarted(item.sid); }
  }
  // The acknowledgement ("On it.") is said the moment main knows the ask; the
  // reply that follows a beat later queues behind it instead of cutting it
  // off mid-word. Past this window the ack is long over and a reply restarts.
  let ackHoldUntil = 0;
  const ACK_HOLD_MS = 2500;
  // A log line about speech never stops the speech.
  function vlog(m) { try { if (nus.log) nus.log(m); } catch (_) { /* never in the way */ } }
  function say(text, opts) {
    const first = !!(opts && opts.restart);
    if (!companionVoiceEnabled || pttHeld) { if (first && text) vlog('voice: not said (' + (pttHeld ? 'the talk key was held' : 'speech is off') + '): "' + String(text).slice(0, 40) + '"'); return; }
    if (!text) return;
    let restart = !opts || opts.restart !== false;
    const line = plainify(String(text)).slice(0, 300);
    if (!line.trim()) return;
    if (opts && opts.ack) ackHoldUntil = Date.now() + ACK_HOLD_MS;
    else if (restart && Date.now() < ackHoldUntil) { restart = false; ackHoldUntil = 0; }
    // A new step's first line: marks still waiting on the old lines belong to nothing now.
    if (restart) { sayWaiting.clear(); marksWaiting.clear(); sayQueue.length = 0; sayBusy = false; voiceGen++; try { speechSynthesis.cancel(); } catch (_) {} if (voiceSource) { try { voiceSource.stop(); } catch (_) {} voiceSource = null; } if (nus.voiceStop) nus.voiceStop(); }
    // A ready-made line plays in the Knot's voice even while the model is
    // still loading: it is a file, not a synthesis.
    const own = Boolean(nus.voiceSay && ownVoice && (ownVoice.ready || (opts && opts.cached && ownVoice.installed)));
    const item = { line, own, first, sid: opts && opts.sid != null ? opts.sid : null };
    if (item.sid != null) sayWaiting.add(item.sid);
    if (own) item.promise = nus.voiceSay(line).then((a) => { item.audio = a; return a; });
    sayQueue.push(item);
    sayNext();
  }

  // ---- actions -----------------------------------------------------------
  // Modes that render without a provider key: guide answers from the local
  // semester snapshot, numbers and brief come straight from the pack. The key
  // ask happens inline the first time an AI mode is actually used.
  const KEYLESS_MODES = new Set(['guide', 'numbers', 'brief']);

  async function runMode(mode, text) {
    if (busy) return;
    const ready = KEYLESS_MODES.has(mode) ? { ok: true } : await (nus.aiReady ? nus.aiReady() : { ok: true });
    if (!ready.ok) {
      // Honest feedback instead of a phantom state flip: the indicator stays
      // where it is and the message says exactly what to do.
      showTiles();
      showStatus(ready.message || 'Add an API key in Settings to start.');
      return;
    }
    stopSpeaking();
    setBusy(true);
    nus.ask({ mode, text: text || '' });
  }

  // Rehearsal: the button starts a session, then ends and clears it. A live
  // transcript turn is fed in by typing or by the Ctrl+Shift+R hotkey.
  let sparring = false;
  const sparBtn = $('#spar-btn');
  function setSparring(v) {
    sparring = v;
    sparBtn.classList.toggle('sparring', v);
    $('#orb').classList.toggle('spar', v);
    syncKnotUi();
    sparBtn.querySelector('span:last-child').textContent = v ? 'End rehearsal' : 'Start rehearsal';
  }

  document.querySelectorAll('.act').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const mode = btn.dataset.mode;
      if (mode === 'spar') {
        if (sparring) {
          await nus.sparReset();
          stopSpeaking();
          showStatus('Rehearsal ended and cleared. Hit "Score me" first if you want the grade.');
          return;
        }
        runMode('spar', '');
        return;
      }
      runMode(mode, '');
    });
  });

  nus.on('spar:state', ({ active }) => setSparring(!!active));

  // Hidden from screen sharing: the capsule says which it is, in words, so a
  // person about to share a screen can check the Knot instead of trusting it.
  nus.on('capture:policy', (p) => {
    const el = $('#share-state');
    if (!el) return;
    const hidden = !!(p && p.hidden);
    el.textContent = hidden ? 'hidden from shares' : 'visible in shares';
    el.classList.toggle('visible-in-shares', !hidden);
    el.classList.remove('hidden');
  });

  const input = $('#input');
  const placeholder = $('#placeholder');
  const composer = $('#composer');

  function syncPlaceholder() {
    placeholder.classList.toggle('hidden', input.value.length > 0 || document.activeElement === input);
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  }
  input.addEventListener('input', syncPlaceholder);
  input.addEventListener('focus', () => { composer.classList.add('focused'); placeholder.classList.add('hidden'); });
  input.addEventListener('blur', () => { composer.classList.remove('focused'); syncPlaceholder(); });
  $('#input-area').addEventListener('click', () => input.focus());

  function send() {
    const text = input.value.trim();
    // An empty send is the guide verb on the desktop; standalone has no plan
    // source, so it is simply nothing.
    if (!text) { if (!standalone) runMode('guide', ''); return; }
    input.value = ''; syncPlaceholder();
    ack();
    // While rehearsing, what you type is your spoken line, not a question.
    runMode(sparring ? 'spar' : 'ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Full-vault query. Bound here rather than globally because it needs the
    // composer text. Slow (15 to 30s), so it is a between-calls tool. Desktop
    // only: the standalone Companion has no vault server to ask.
    if (!standalone && isCmdOrCtrl(e) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) { showStatus('Type a question first, then ' + cmdKey + '+Shift+D to ask the whole vault.'); return; }
      input.value = ''; syncPlaceholder();
      setBusy(true);
      nus.deepQuery(text);
      return;
    }
    const captured = keyEventToAccelerator(e);
    if (!standalone && captured.accelerator && captured.accelerator.toLowerCase() === assistShortcut.toLowerCase()) {
      e.preventDefault(); runMode('guide', ''); return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); send(); }
  });

  // The Knot: while a thread is out, one click winds it back. Otherwise it
  // opens the quick ask (one line, type, Enter), or closes whatever is open.
  // A double-click is one activation: the second click used to arrive as a
  // second `click`, close the composer that the first had just opened, and
  // hand the mouse back to the desktop, which read as the Companion vanishing.
  // Chromium counts the clicks for us (e.detail is 2 on the second click of a
  // double-click, using the OS double-click time); the timestamp check is the
  // fallback for a click that arrives after a stalled frame.
  // Ported 2026-09-15 from the 2026-09-10 fix in the main tree.
  const KNOT_CLICK_REPEAT_MS = 400; // under Windows' 500ms double-click time
  const KNOT_DOUBLE_TAP_MS = 350;
  let lastKnotClick = 0;
  function knotClickRepeated(e) {
    const at = e && e.timeStamp ? e.timeStamp : performance.now();
    // Measured 2026-09-10: timing against the last ACCEPTED click let a fast
    // burst toggle the composer every sixth click. Time against the previous
    // click of any kind, so a burst changes nothing until it stops for 400ms.
    const repeated = (e && e.detail > 1) || at - lastKnotClick < KNOT_CLICK_REPEAT_MS;
    lastKnotClick = at;
    return repeated;
  }
  // Poked: a small lean away from the finger. Only a click that did not turn
  // into a drag pokes; a drag ends in a settle instead.
  function pokeKnot(e) {
    if (!knot3d || !knot3d.gesture) return;
    const r = $('#orb').getBoundingClientRect();
    knot3d.gesture('poke', { dx: (e.clientX - (r.left + r.width / 2)) / (r.width / 2), dy: (e.clientY - (r.top + r.height / 2)) / (r.height / 2) });
    cues.play('poke');
  }
  $('#orb').addEventListener('click', (e) => {
    if (suppressClick) { suppressClick = false; return; } // the release of a drag
    if (play && play.active) return; // a press in a game is the game's
    pokeKnot(e);
    // In the pill, with tasks to show, the Knot unfolds the list. Nothing listed: as ever.
    if (islandOn && taskPanel && taskPanel.available()) { taskPanel.toggle(); return; }
    // A finger has no hover: on a touchscreen one tap on the free Knot is the hover,
    // and the second tap of a double tap has already gone to the dashboard.
    // With nothing listed one tap stays what a click is: the ask line.
    if (orbPointerType === 'touch' && knotPanel && (knotPanel.open || (knotPanel.hasListed() && knotPanelMayOpen()))) { if (performance.now() - knotDashAt >= 600) knotPanelTap(); return; }
    if (knotPanel && knotPanel.open) knotPanelShut();
    if (knotClickRepeated(e)) { if (quickOpen) $('#quick-input').focus(); return; }
    if (guideActive()) dismissGuide('knot');
    else if (quickOpen) closeQuickAsk();
    else if (isShown(panel, 'collapsed')) { hideTiles(); releaseKeys(); }
    else { openQuickAsk(); if (!islandOn && knotMenu && !isShown(tourEl)) knotMenu.show('knot'); }
  });
  // A double click on the Knot opens the dashboard (live 2026-11-03: "I don't
  // even see the dashboard anywhere to access it").
  // A double tap too: Chromium does not always report one as a dblclick, so taps
  // are counted here as well, and whichever comes second does nothing.
  let knotDashAt = 0, knotTapAt = 0;
  function knotDashboard() {
    if (performance.now() - knotDashAt < 600) return;
    knotDashAt = performance.now();
    if (quickOpen) closeQuickAsk();
    if (knotMenu) knotMenu.close();
    if (knotPanel && knotPanel.open) knotPanelShut();
    nus.guideAsk({ action: 'menu-dashboard' });
  }
  let orbPointerType = '';
  $('#orb').addEventListener('pointerdown', (e) => { orbPointerType = e.pointerType; });
  $('#orb').addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); if (play && play.active) return; knotDashboard(); });
  $('#orb').addEventListener('pointerup', (e) => {
    if (e.pointerType !== 'touch' || suppressClick) return;
    if (e.timeStamp - knotTapAt < KNOT_DOUBLE_TAP_MS) { knotTapAt = 0; knotDashboard(); } else knotTapAt = e.timeStamp;
  });

  function toggleCaptureFromUi() {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) startSystemAudio();
    nus.captureToggle();
  }
  $('#stop-btn').addEventListener('click', toggleCaptureFromUi);

  // ---- voice wave -------------------------------------------------------
  // Live proof the mic is actually hearing you. Levels arrive from the PCM
  // worklet (RMS per block); the bars decay on their own so silence reads as
  // a flat line rather than a frozen shape.
  const WAVE_BARS = 22;
  const waveLevels = new Array(WAVE_BARS).fill(0);
  let waveEl = null, waveRaf = null, lastLevel = 0;

  function setMicError(message) {
    const chip = $('#capture-chip');
    if (chip) chip.classList.toggle('mic-error', Boolean(message));
  }

  function pushLevel(level) {
    // Speech RMS is small; scale and clamp so normal talking fills the bars.
    lastLevel = Math.min(1, Math.max(0, (level || 0) * 7));
  }

  function paintWave() {
    if (!waveEl) waveEl = $('#voice-wave');
    if (waveEl) {
      waveLevels.push(lastLevel);
      waveLevels.shift();
      lastLevel *= 0.72;                       // decay between worklet posts
      const bars = waveEl.children;
      for (let i = 0; i < bars.length; i++) {
        const v = waveLevels[i] || 0;
        bars[i].style.transform = 'scaleY(' + (0.08 + v * 0.92).toFixed(3) + ')';
        bars[i].style.opacity = (0.35 + v * 0.65).toFixed(3);
      }
    }
    waveRaf = requestAnimationFrame(paintWave);
  }

  function startWave() {
    const host = $('#voice-wave');
    if (host && !host.children.length) host.innerHTML = new Array(WAVE_BARS).fill('<i></i>').join('');
    waveLevels.fill(0);
    if (!waveRaf) paintWave();
  }

  function stopWave() {
    if (waveRaf) { cancelAnimationFrame(waveRaf); waveRaf = null; }
    waveLevels.fill(0);
    lastLevel = 0;
    const host = $('#voice-wave');
    if (host) [...host.children].forEach((bar) => { bar.style.transform = 'scaleY(0.08)'; bar.style.opacity = '.3'; });
  }

  // ---- capture: mic (renderer side) --------------------------------------
  let audioCtx = null, micStream = null, micNode = null, micProc = null;
  let pttHeld = false;
  const captureOn = () => $('#stop-btn').classList.contains('active');
  // A mic that died underneath us (Chromium's audio service was killed, the
  // device was unplugged, the context closed) must not count as "already
  // open": crash.log 2026-10-29 showed audio.mojom.AudioService killed, after
  // which startMic returned early on a dead stream until a restart.
  function micDead() {
    if (!micStream) return false;
    const tracks = micStream.getAudioTracks();
    return !tracks.length || tracks.every((t) => t.readyState === 'ended') || !audioCtx || audioCtx.state === 'closed';
  }
  // Which microphone (companion/renderer/mic-devices.js): the one picked in Settings or on the
  // tour's microphone card, else the Windows default. micOpenId is the device open now ('' the
  // default, null when the mic is closed); micFoundList the devices last seen.
  const NM = window.NusMic;
  let micOpenId = null, micFoundList = null, micMissingSaid = '', micLastError = '';
  async function micFound() {
    try { return NM.inputs(await navigator.mediaDevices.enumerateDevices()); } catch (_) { return { list: [], defaultLabel: '' }; }
  }
  async function openMicStream() {
    const found = await micFound();
    micFoundList = found;
    nus.log('mic: ' + found.list.length + ' input device(s), default ' + (found.defaultLabel || 'unnamed') + (settings && settings.micDeviceId ? ', picked ' + (settings.micDeviceLabel || 'one') : ''));
    const want = NM.choose(found, settings || {});
    // The chosen one is not plugged in: the Windows default stands in, said once per device.
    if (want.why === 'missing' && micMissingSaid !== want.wanted) { micMissingSaid = want.wanted; showStatus((want.wanted || 'Your microphone') + ' is not plugged in. Using ' + (want.label || (/Mac/.test(navigator.platform || '') ? 'the Mac default' : 'the Windows default')) + '.'); }
    try {
      const stream = await navigator.mediaDevices.getUserMedia(NM.constraints(want.id));
      micOpenId = want.id;
      return stream;
    } catch (err) {
      // A picked device that will not open: the Windows default instead, before giving up.
      if (!want.id) throw err;
      nus.log('mic: ' + (want.label || 'picked device') + ' did not open (' + (err && err.name) + '), trying the default');
      const stream = await navigator.mediaDevices.getUserMedia(NM.constraints(''));
      micOpenId = '';
      return stream;
    }
  }
  async function startMic() {
    if (micDead()) { nus.log('mic: previous stream is dead, reopening'); stopMic(); }
    if (micStream) return;
    try {
      micLastError = '';
      micStream = await openMicStream();
      micStream.getAudioTracks().forEach((t) => { t.onended = () => { nus.log('mic: track ended (' + (t.label || 'device') + ')'); if (!pttHeld) stopMic(); }; });
      // The chord was released before the mic came up: it stays warm for the
      // next press (the idle timer in ptt:state closes it), audio dropped.
      // Do NOT force sampleRate here: some Windows drivers reject the context
      // outright, which is why capture could silently produce nothing. Take
      // whatever rate we get and downsample inside the worklet.
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      await audioCtx.audioWorklet.addModule('./pcm-processor.js');
      micNode = audioCtx.createMediaStreamSource(micStream);
      micProc = new AudioWorkletNode(audioCtx, 'pcm-processor', { processorOptions: { targetRate: 16000 } });
      // One mic, two sinks: push-to-talk while the chord is held, the
      // meeting transcript otherwise.
      // One mic, two sinks, and a third case: between presses the mic stays
      // warm for a while (see ptt:state) and its audio goes nowhere.
      micProc.port.onmessage = (e) => {
        if (pttHeld) nus.pttPcm(e.data.buffer);
        else if (captureOn()) nus.micPcm(e.data.buffer);
        else if (tourMic) { tourLevel(e.data.level); return; }
        else return;
        pushLevel(e.data.level);
        if (pttHeld && knot3d && knot3d.setLevel) knot3d.setLevel(Math.min(1, (e.data.level || 0) * 7));
      };
      const sink = audioCtx.createGain(); sink.gain.value = 0; // run processor silently
      micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
      const label = micStream.getAudioTracks()[0]?.label || 'default device';
      nus.log('mic: capturing at ' + audioCtx.sampleRate + 'Hz via ' + label);
      setMicError('');
      // Names show only once the mic may be used: read the list again now.
      micFound().then((f) => { micFoundList = f; if (tourCard && tourCard.kind === 'mic') renderTourMics(); });
    } catch (err) {
      micLastError = (err && err.name) || 'Error';
      micOpenId = null;
      const message = (err && err.name === 'NotAllowedError')
        ? (/Mac/.test(navigator.platform || '') ? 'Microphone blocked. Allow it in System Settings > Privacy & Security > Microphone, then click Listen again.' : 'Microphone blocked. Allow it in Windows Settings > Privacy > Microphone, then click Listen again.')
        : (err && err.name === 'NotFoundError')
          ? 'No microphone found. Plug one in and click Listen again.'
          : 'Microphone failed: ' + (err && err.message);
      nus.log('mic error: ' + (err && err.message));
      setMicError(message);
      showStatus(message);
    }
  }

  function stopMic() {
    micOpenId = null;
    if (micProc) { micProc.port.onmessage = null; micProc.disconnect(); micProc = null; }
    if (micNode) { micNode.disconnect(); micNode = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }
  // Open again on the device that should be open now, if the mic is open at all.
  function reopenMic(why) {
    if (!micStream) return;
    nus.log('mic: reopening (' + why + ')');
    stopMic(); startMic();
  }
  // A microphone plugged in or pulled out: follow it, and say so in plain words.
  let micChangeTimer = null;
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) navigator.mediaDevices.addEventListener('devicechange', () => {
    clearTimeout(micChangeTimer);
    micChangeTimer = setTimeout(async () => {
      const next = await micFound();
      const r = NM.react(micFoundList, next, settings || {}, micStream ? micOpenId : null);
      micFoundList = next;
      if (r.added.length || r.removed.length) nus.log('mic: devices changed (+' + r.added.length + ' -' + r.removed.length + '), now ' + next.list.length);
      if (r.message) showStatus(r.message);
      if (r.reopen) reopenMic('device change');
      if (tourCard && tourCard.kind === 'mic') { renderTourMics(); if (!micStream && tourMic) setTourMicAgain(); }
    }, 400);
  });
  // The pick changed (Settings, or the tour's card): the open mic moves to it.
  let micPickSeen = null;
  nus.on('settings:changed', (s) => {
    const pick = (s && s.micDeviceId) || '';
    if (micPickSeen === null) { micPickSeen = pick; return; }
    if (pick === micPickSeen) return;
    micPickSeen = pick; micMissingSaid = '';
    if (settings) { settings.micDeviceId = pick; settings.micDeviceLabel = (s && s.micDeviceLabel) || ''; }
    reopenMic('new pick');
    if (tourCard && tourCard.kind === 'mic') renderTourMics();
  });

  // ---- capture: system/meeting audio (getDisplayMedia loopback, in the app's own process) ----
  let sysStream = null, sysCtx = null, sysNode = null, sysProc = null;
  async function startSystemAudio() {
    if (sysStream) return;
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      stream.getVideoTracks().forEach((t) => t.stop()); // we only want the audio
      const tracks = stream.getAudioTracks();
      if (!tracks.length) { nus.log('system audio: no loopback track (macOS loopback unsupported here)'); stream.getTracks().forEach((t) => t.stop()); return; }
      sysStream = stream;
      sysCtx = new AudioContext();
      if (sysCtx.state === 'suspended') await sysCtx.resume();
      await sysCtx.audioWorklet.addModule('./pcm-processor.js');
      sysNode = sysCtx.createMediaStreamSource(new MediaStream(tracks));
      sysProc = new AudioWorkletNode(sysCtx, 'pcm-processor', { processorOptions: { targetRate: 16000 } });
      sysProc.port.onmessage = (e) => { nus.systemPcm(e.data.buffer); pushLevel(e.data.level * 0.6); };
      const sink = sysCtx.createGain(); sink.gain.value = 0;
      sysNode.connect(sysProc); sysProc.connect(sink); sink.connect(sysCtx.destination);
      nus.log('system audio: capturing loopback');
    } catch (err) {
      nus.log('system audio error: ' + (err && err.message));
    }
  }
  function stopSystemAudio() {
    if (sysProc) { sysProc.port.onmessage = null; sysProc.disconnect(); sysProc = null; }
    if (sysNode) { sysNode.disconnect(); sysNode = null; }
    if (sysCtx) { sysCtx.close(); sysCtx = null; }
    if (sysStream) { sysStream.getTracks().forEach((t) => t.stop()); sysStream = null; }
  }

  // ---- events from main --------------------------------------------------
  let captureStartedAt = null;
  let captureClockTimer = null;
  function captureTime() {
    const elapsed = captureStartedAt ? Math.max(0, Math.floor((Date.now() - captureStartedAt) / 1000)) : 0;
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');
    $('#capture-clock').textContent = minutes + ':' + seconds;
  }
  function syncCaptureUi(active) {
    $('#live-dot').classList.toggle('off', !active);
    $('#capture-chip').classList.toggle('off', !active);
    $('#stop-btn').classList.toggle('active', active);
    $('#orb').classList.toggle('listening', active);
    // The call tools only exist during a call: dead buttons teach people that
    // buttons here are sometimes dead, so they never appear dead.
    $('#live-cluster').classList.toggle('hidden', !active);
    syncKnotUi();
    clearInterval(captureClockTimer);
    captureClockTimer = null;
    if (active) {
      if (!captureStartedAt) captureStartedAt = Date.now();
      captureTime();
      captureClockTimer = setInterval(captureTime, 1000);
    } else {
      captureStartedAt = null;
      $('#capture-clock').textContent = '00:00';
    }
  }
  // Push-to-talk: main owns the chord (down from the hotkey, up from the
  // probe); this side just points the mic at it while it is held.
  // The mic used to be opened on every press (getUserMedia, a new
  // AudioContext, the worklet), which clipped the first syllables. It now
  // stays open for MIC_WARM_MS after a release, its audio dropped, so the
  // next press hears from the first frame; after that it closes.
  const MIC_WARM_MS = 45000;
  let micIdleTimer = null;
  nus.on('ptt:state', ({ held }) => {
    pttHeld = !!held;
    if (pttHeld && play && play.active) stopPlay('task');
    tourPtt(pttHeld);
    if (islandOn) syncKnotUi(); else syncIsland(lastIslandState);
    clearTimeout(micIdleTimer); micIdleTimer = null;
    // The talk key: a new ask is coming, and the screen it is about should be clean of the last one's marks.
    if (pttHeld) clearMarks(true);
    if (pttHeld) { stopSpeaking(); startMic(); }
    else {
      if (knot3d && knot3d.setLevel) knot3d.setLevel(0);
      if (!captureOn()) micIdleTimer = setTimeout(() => { if (!pttHeld && !captureOn()) stopMic(); }, MIC_WARM_MS);
      ack({ silent: true });
      cues.play('release');
    }
    // A tone already on its way must not reach the mic: silence it the moment
    // the mic opens. The press pop is the one sound allowed through, by design
    // (renders-0115 O5): it marks the mic opening, and the whisper test shows
    // the transcript stays clean under it.
    if (pttHeld && cues.quiet) cues.quiet();
    if (pttHeld) cues.play('press', { force: true });
  });
  // Cues never play while the mic is live, so none can reach transcription,
  // and never over its own speech.
  cues.setGate(() => pttHeld || captureOn() || speakingNow);
  nus.on('capture:state', ({ active }) => {
    syncCaptureUi(active);
    if (active) { setMicError(''); startWave(); startMic(); startSystemAudio(); }
    else { stopWave(); stopMic(); stopSystemAudio(); }
  });
  nus.on('llm:start', ({ userBubble, small }) => {
    ensureAck();
    clearAck();
    setBusy(true);                                   // thinking paints first...
    showTiles();                                     // ...then the tiles materialize
    clearMessages();
    if (userBubble) addUserBubble(userBubble);
    startAi(!!small);
    setBusy(true);
  });
  nus.on('llm:token', ({ text }) => appendToken(text));
  nus.on('llm:done', () => { speak(finalizeAi()); setBusy(false); scheduleSheetClose(); cues.play('done'); if (knot3d && knot3d.gesture) knot3d.gesture('done'); });
  nus.on('llm:busy', () => { setBusy(false); clearAck(); showStatus('Still working on the last one.'); });
  nus.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
    errorBeat();
  });
  let statusTimer = null;
  function showStatus(message) {
    let el = document.getElementById('nus-status');
    if (!el) {
      el = document.createElement('div');
      el.id = 'nus-status';
      const row = document.getElementById('primary-row');
      row.parentNode.insertBefore(el, row); // top of the controls tile
    }
    // Statuses matter (transcription off, key missing). The desktop surfaces
    // them at the top of the sheet; standalone says them in the hint pill by
    // the Knot instead of popping a sheet that then never closes.
    if (standalone) { showHint({ text: message, ms: 7000 }); return; }
    showTiles();
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  nus.on('status', ({ message }) => { nus.log('[status] ' + message); showStatus(message); });

  // ---- the daily line ----------------------------------------------------
  // Once a day the main process sends the top ranked next move. It sits above
  // the Knot until clicked; the click opens the full local guide answer.
  const dailyLine = $('#daily-line');
  nus.on('daily:line', ({ text }) => {
    if (!text) return;
    dailyLine.textContent = text;
    showSurface(dailyLine);
  });
  dailyLine.addEventListener('click', () => {
    hideSurface(dailyLine);
    runMode('guide', '');
  });

  // Rehearsal tools require a briefing pack built by the vault; without one
  // (or founder mode) the cluster does not exist.
  function syncRehearsalCluster() {
    const hasPack = !!(settings && (settings.packPath || settings.sparPath));
    const founder = !!(settings && settings._founderTools);
    // Standalone never shows the meeting tools, pack or not.
    $('#rehearsal-cluster').classList.toggle('hidden', standalone || !(hasPack || founder));
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  // Take the mouse immediately: waiting for a probe tick to notice the modal
  // is what made the panel look open but dead to clicks.
  function openSettings() { fillSettings(); showSurface(scrim); setIgnoreSafe(false); }
  function closeSettings() { cancelShortcutRecording(); saveSettings(); hideSurface(scrim); setIgnoreSafe(true); }
  // Standalone has one settings surface, the Nūs Companion window; the overlay
  // sheet stays for the desktop build. Same gear, same shortcut, one place.
  function openAnySettings(section) { if (standalone && nus.openSettings) nus.openSettings(section || ''); else openSettings(); }
  $('#more-btn').addEventListener('click', () => openAnySettings());
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });

  function fillSettings() {
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-typesafe').value = settings.apiKeys.typesafe || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-nvidia').value = settings.apiKeys.nvidia || '';
    $('#resume-context').value = settings.resumeContext || '';
    $('#pack-path').value = settings.packPath || '';
    $('#spar-path').value = settings.sparPath || '';
    $('#smart-mode').checked = !!settings.smart;
    $('#speak-replies').checked = !!settings.speakReplies;
    $('#persist-transcripts').checked = settings.persistTranscripts !== false;
    $('#save-audio').checked = settings.saveAudio === true;
    $('#stealth-mode').checked = settings.stealth === true;
    $('#share-nus-context').checked = !!settings.shareNusContextWithProvider;
    $('#report-to-nus').checked = !!settings.reportToNus;
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    syncAssistShortcutLabels();
    $('#s-status').textContent = statusText();
    refreshPackStatus();
    refreshNusContext();
  }

  async function refreshNusContext() {
    if (standalone) return;
    const el = $('#nus-link-status');
    if (!el || !nus.nusContextStatus) return;
    try {
      const status = await nus.nusContextStatus();
      el.classList.toggle('linked', !!status.ok);
      el.textContent = status.ok
        ? 'Nūs desktop linked · context refreshed ' + new Date(status.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
        : 'Nūs desktop offline · open the desktop app once to create shared context';
    } catch (_) {
      el.textContent = 'Nūs desktop link unavailable';
    }
  }

  // Show whether the packs actually loaded, so a bad path is caught in Settings
  // rather than mid-call.
  async function refreshPackStatus() {
    const el = $('#pack-status');
    try {
      const st = await nus.packStatus();
      const bits = [];
      bits.push(st.live.ok ? 'Live pack loaded (' + st.live.chars.toLocaleString() + ' chars)' : (st.live.path ? 'Live pack FAILED: ' + st.live.error : 'No live pack set'));
      bits.push(st.spar.ok ? 'spar pack loaded (' + st.spar.chars.toLocaleString() + ' chars)' : (st.spar.path ? 'spar pack FAILED: ' + st.spar.error : 'no spar pack set'));
      el.textContent = bits.join(' · ');
    } catch (_) {
      el.textContent = 'Could not read pack status.';
    }
  }

  $('#reload-pack').addEventListener('click', async () => {
    settings.packPath = $('#pack-path').value.trim();
    settings.sparPath = $('#spar-path').value.trim();
    await nus.settingsSet({ packPath: settings.packPath, sparPath: settings.sparPath });
    refreshPackStatus();
    syncRehearsalCluster();
  });

  $('#speak-replies').addEventListener('change', async (e) => {
    settings.speakReplies = e.target.checked;
    if (!settings.speakReplies) stopSpeaking();
    await nus.settingsSet({ speakReplies: settings.speakReplies });
  });
  $('#clear-resume').addEventListener('click', async () => {
    $('#resume-context').value = '';
    settings.resumeContext = '';
    await nus.settingsSet({ resumeContext: '' });
  });
  function statusText() {
    const k = settings.apiKeys;
    const has = [k.openai && 'OpenAI', k.anthropic && 'Anthropic', k.gemini && 'Gemini', k.nvidia && 'Nvidia'].filter(Boolean);
    const stt = k.openai ? 'Whisper' : (k.gemini ? 'Gemini' : 'none');
    const base = 'Active: ' + settings.provider + ' · keys: ' + (has.join(', ') || 'none set') + ' · transcription: ' + stt;
    return (settings._migrationNote && !has.length) ? settings._migrationNote + '\n' + base : base;
  }
  document.querySelectorAll('#provider-seg button').forEach((b) => b.addEventListener('click', () => {
    settings.provider = b.dataset.provider;
    document.querySelectorAll('#provider-seg button').forEach((x) => x.classList.toggle('on', x === b));
    const m = settings.models[settings.provider] || { fast: '', smart: '' };
    $('#model-fast').value = m.fast; $('#model-smart').value = m.smart;
    $('#s-status').textContent = statusText();
  }));
  async function saveSettings() {
    settings.apiKeys.typesafe = $('#key-typesafe').value.trim();
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.nvidia = $('#key-nvidia').value.trim();
    settings.resumeContext = $('#resume-context').value.trim();
    settings.packPath = $('#pack-path').value.trim();
    settings.sparPath = $('#spar-path').value.trim();
    settings.smart = $('#smart-mode').checked;
    settings.speakReplies = $('#speak-replies').checked;
    settings.shareNusContextWithProvider = $('#share-nus-context').checked;
    settings.reportToNus = $('#report-to-nus').checked;
    settings.persistTranscripts = $('#persist-transcripts').checked;
    settings.saveAudio = $('#save-audio').checked;
    settings.stealth = $('#stealth-mode').checked;
    if (!settings.models[settings.provider]) settings.models[settings.provider] = {};
    settings.models[settings.provider].fast = $('#model-fast').value.trim();
    settings.models[settings.provider].smart = $('#model-smart').value.trim();
    await nus.settingsSet(settings);
    syncRehearsalCluster();
  }

  // Assist shortcut recorder. The renderer captures a key combination and the
  // main process only saves it after Electron confirms the global registration.
  const shortcutBtn = $('#shortcut-assist');
  const shortcutHint = $('#shortcut-hint');

  function setShortcutHint(message, kind) {
    shortcutHint.textContent = message;
    shortcutHint.classList.toggle('error', kind === 'error');
    shortcutHint.classList.toggle('success', kind === 'success');
  }

  function cancelShortcutRecording() {
    recordingShortcut = false;
    shortcutBtn.classList.remove('recording');
    syncAssistShortcutLabels();
  }

  function keyEventToAccelerator(e) {
    const modifierKeys = new Set(['Meta', 'Control', 'Alt', 'Shift']);
    if (modifierKeys.has(e.key)) return { error: 'Press a modifier together with another key.' };

    const parts = [];
    const primaryDown = nus.platform === 'darwin' ? e.metaKey : e.ctrlKey;
    if (primaryDown) parts.push('CommandOrControl');
    if (nus.platform === 'darwin' && e.ctrlKey) parts.push('Control');
    if (nus.platform !== 'darwin' && e.metaKey) parts.push('Super');
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');

    const named = {
      Enter: 'Return', ' ': 'Space', Tab: 'Tab', Backspace: 'Backspace',
      Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down',
      ArrowLeft: 'Left', ArrowRight: 'Right'
    };
    const punctuation = { '+': 'Plus', '-': '-', '=': '=', ',': ',', '.': '.', '/': '/', ';': ';', "'": "'", '[': '[', ']': ']', '\\': '\\', '`': '`' };
    let key = named[e.key] || punctuation[e.key] || '';
    if (!key && /^[a-z]$/i.test(e.key)) key = e.key.toUpperCase();
    if (!key && /^[0-9]$/.test(e.key)) key = e.key;
    if (!key && /^F(?:[1-9]|1[0-9]|2[0-4])$/.test(e.key)) key = e.key;
    if (!key) return { error: 'Use a letter, number, function key, arrow, or common navigation key.' };
    if (!parts.length && !/^F/.test(key)) return { error: nus.platform === 'darwin' ? 'Include Command, Control, Option, or Shift in the shortcut.' : 'Include Command/Ctrl, Alt, or Shift in the shortcut.' };
    parts.push(key);
    return { accelerator: parts.join('+') };
  }

  async function applyAssistShortcut(accelerator) {
    const wasRecording = recordingShortcut;
    recordingShortcut = false;
    shortcutBtn.classList.remove('recording');
    shortcutBtn.textContent = 'Saving…';
    let result;
    try {
      result = await nus.shortcutAssistSet(accelerator);
    } catch (_) {
      result = { ok: false, error: 'The Companion could not update the shortcut. Please try again.' };
    }
    if (!result.ok) {
      setShortcutHint(result.error, 'error');
      recordingShortcut = wasRecording;
      shortcutBtn.classList.toggle('recording', recordingShortcut);
      if (recordingShortcut) shortcutBtn.textContent = 'Press keys…';
      else syncAssistShortcutLabels();
      return;
    }
    assistShortcut = result.accelerator;
    if (!settings.shortcuts) settings.shortcuts = {};
    settings.shortcuts.assist = assistShortcut;
    cancelShortcutRecording();
    setShortcutHint('Assist shortcut updated.', 'success');
  }

  shortcutBtn.addEventListener('click', () => {
    recordingShortcut = true;
    shortcutBtn.classList.add('recording');
    shortcutBtn.textContent = 'Press keys…';
    setShortcutHint('Press Escape to cancel.', '');
  });

  $('#shortcut-reset').addEventListener('click', () => applyAssistShortcut(DEFAULT_ASSIST_SHORTCUT));

  document.addEventListener('keydown', (e) => {
    if (!recordingShortcut) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      cancelShortcutRecording();
      setShortcutHint('Shortcut change cancelled.', '');
      return;
    }
    const captured = keyEventToAccelerator(e);
    if (captured.error) {
      setShortcutHint(captured.error, 'error');
      return;
    }
    applyAssistShortcut(captured.accelerator);
  }, true);

  // ---- example conversation (matches the reference screenshot) ------------

  // ---- global keys -------------------------------------------------------
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isShown(scrim)) { closeSettings(); return; }
    if (e.key === 'Escape' && knotMenu && knotMenu.open) { knotMenu.close(); return; }
    if (e.key === 'Escape' && knotPanel && knotPanelBack()) return;
    if (e.key === 'Escape' && taskPanel && taskPanel.back()) return;
    if (e.key === 'Escape' && guideActive()) { dismissGuide('esc'); return; }
    if (e.key === 'Escape' && quickOpen) { closeQuickAsk(); return; }
    if (isCmdOrCtrl(e)) {
      if (e.key === ',') { e.preventDefault(); openAnySettings(); }
    }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  const setIgnore = setIgnoreSafe;
  function modalOpen() {
    const s = document.getElementById('settings-scrim'), o = document.getElementById('onboard-scrim');
    return isShown(s) || isShown(o);
  }
  function overPillAt(cssX, cssY) {
    const el = document.elementFromPoint(cssX, cssY);
    return !!(el && el.closest && el.closest('#island.live, #island .tp, #knot-panel, #knot-menu'));
  }
  function overUIAt(cssX, cssY) {
    // A modal covers the window and owns every click while it is up. Never let
    // a stray probe hand the mouse back to the desktop underneath it. Same
    // while the Knot is being dragged or a file is being dragged over it.
    if (modalOpen() || dragging || fileDragActive) return true;
    // The game on: the whole screen is the court (play.js).
    if (play && play.active) return true;
    const el = document.elementFromPoint(cssX, cssY);
    return !!(el && el.closest && el.closest('#knot-shell, #island .tp, #panel-wrap, #settings-scrim, #onboard-scrim, #daily-line, #guide-bubble, #keep-chip, #quick-ask, #knot-hint, #tour, #tour-tuck') || overPillAt(cssX, cssY));
  }
  // Main says when a finger is in use: the overlay then stays click-through, so a
  // tap off the controls reaches the app, and taps on them come by the touch pad.
  let fingerInUse = false;
  // Where the probe last saw the pointer, in CSS pixels. Null: off this window.
  let pointerAt = null;
  document.addEventListener('mousemove', (e) => { pointerAt = { x: e.clientX, y: e.clientY }; if (!fingerInUse) setIgnore(!overUIAt(e.clientX, e.clientY)); });
  // Holding the whole screen's clicks should only ever happen at the Knot and what
  // hangs off it. Anywhere else, one line in route.log names what asked for it, so
  // a live run can prove it (live 2026-11-03: 2.4 s with nothing named).
  const FAR_FROM_KNOT_PX = 120;
  let mouseNotedAt = 0;
  function knotCentre() { const z = zoomFactor(), r = orbEl.getBoundingClientRect(); return { x: (r.left + r.width / 2) * z, y: (r.top + r.height / 2) * z }; }
  function noteMouseTaken() {
    if (!pointerAt || !nus.noteMouse) return;
    const z = zoomFactor(), k = knotCentre(), x = pointerAt.x * z, y = pointerAt.y * z;
    if (Math.hypot(x - k.x, y - k.y) <= FAR_FROM_KNOT_PX) return;
    const now = Date.now();
    if (now - mouseNotedAt < 1000) return;
    mouseNotedAt = now;
    let by = dragging ? 'dragging' : fileDragActive ? 'file-drag' : modalOpen() ? 'modal' : (play && play.active) ? 'play' : '';
    if (!by) { const el = document.elementFromPoint(pointerAt.x, pointerAt.y); by = el ? (el.id ? '#' + el.id : el.tagName.toLowerCase()) : 'nothing'; }
    nus.noteMouse({ by, x, y, knotX: k.x, knotY: k.y });
  }
  // Windows: forwarded mousemove is unreliable while click-through, so the main
  // process polls the cursor and asks us what is under it. Window coords arrive
  // in DIPs; divide by the zoom factor to get CSS pixels for elementFromPoint.
  nus.on('cursor:probe', ({ x, y, touch, handsMoving }) => {
    const z = Math.pow(1.2, (nus.getZoomLevel && nus.getZoomLevel()) || 0);
    pointerAt = { x: x / z, y: y / z };
    // While it listens the Knot leans a little toward the cursor.
    if (knot3d && knot3d.setPointer) knot3d.setPointer({ x: x / z, y: y / z });
    fingerInUse = !!touch;
    setIgnore(fingerInUse ? !modalOpen() : !overUIAt(x / z, y / z));
    // Hands has the overlay click-through; the pill asks for the mouse each tick,
    // and main allows it only between Hands' moves.
    if (pillReady && handsState.active && overPillAt(x / z, y / z)) nus.setIgnoreMouse(false, 'pill');
    // Every tick says what it wants, changed or not: main keeps the window to it,
    // and a page that stops saying so loses the mouse (src/overlay-mouse.js).
    nus.setIgnoreMouse(ignoring);
    if (pillReady) pointerTick(x / z, y / z, handsMoving);
  });
  // The pointer left the window altogether (another display).
  nus.on('cursor:away', () => { pointerAt = null; if (pillReady) pointerTick(-1, -1); });
  // Main let go of the mouse because this page was held up. The flag follows, or
  // the guard in setIgnoreSafe would swallow the next change.
  nus.on('mouse:forced', () => { ignoring = true; });
  setIgnore(true); // start fully click-through; hovering the UI re-enables it

  // A finger has no hover, so on a touchscreen an invisible window catches taps on
  // these controls and they arrive here (companion/src/touch-pad.js). The same list
  // as overUIAt and overPillAt. Nothing runs without a touchscreen.
  const TOUCH_CONTROLS = '#play-hud, #knot-shell, #island .tp, #panel-wrap, #settings-scrim, #onboard-scrim, #daily-line, #guide-bubble, #keep-chip, #quick-ask, #knot-hint, #tour, #tour-tuck, #island.live, #knot-panel, #knot-menu';
  if (navigator.maxTouchPoints > 0 && nus.touchPadRects && window.NusTouchForward) {
    const padZoom = () => Math.pow(1.2, (nus.getZoomLevel && nus.getZoomLevel()) || 0);
    const padForward = window.NusTouchForward.create({ doc: document, view: window, zoom: padZoom });
    nus.on('touchpad:event', (ev) => {
      // A text field needs the keyboard, which a real click would have brought.
      if (padForward.handle(ev) === 'tap' && document.activeElement && document.activeElement.matches('input, textarea, [contenteditable="true"]')) nus.touchPadFocus();
    });
    document.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch' && e.isTrusted) nus.touchPadSeen(); }, true);
    let padSent = '';
    setInterval(() => {
      const rects = window.NusTouchForward.rectsOf(document, window, TOUCH_CONTROLS, padZoom());
      const key = JSON.stringify(rects);
      if (key !== padSent) { padSent = key; nus.touchPadRects(rects); }
    }, 150);
  }

  // ---- the first-run tour ---------------------------------------------------
  // Eleven cards on the Knot's own sheet (companion/src/tour.js has the words,
  // main runs the steps). The sheet sits by the Knot like a bubble and never
  // leaves between cards: one card morphs into the next in place (the height
  // eases, the old words fade out over the new). While a demo has the screen it
  // folds into one line at the bottom left in a single motion and unfolds the
  // same way, so the Knot is free to fly and the demo's own cards can take its
  // place by the Knot. Cards arrive as tour:card, changes as tour:update, the
  // end as tour:end.
  const tourEl = $('#tour'), tourTuck = $('#tour-tuck');
  const trKicker = $('#tr-kicker'), trDots = $('#tr-dots'), trProgress = $('#tr-progress'), trTitle = $('#tr-title'), trBody = $('#tr-body'), trMid = $('#tr-mid'), trStatus = $('#tr-status'), trActions = $('#tr-actions'), trSkip = $('#tr-skip');
  let tourMic = false, tourMicTimer = null, tourHeardMs = 0, tourLevelAt = 0, tourHeardSent = false, tourBars = null, tourBarsRaf = 0;
  const tourLevels = new Array(34).fill(0);
  // Timings of the morph and the fold (ms). The frame eases over MORPH, the
  // old words are gone by GHOST, the new ones are in by GHOST + IN.
  const TR = { morph: 260, ghost: 120, in: 180, fold: 280, follow: 420 };
  const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  // NUS_TOUR_TRACE=1: a trace of every card change for the captures: click,
  // card, first paint, speech, each in ms since the click, in the log and on
  // window.__nusTour.trace. Main turns it on with the first card, so off it
  // costs nothing.
  const tourTrace = { on: false, marks: [], clickAt: 0 };
  function trMark(what) {
    if (!tourTrace.on) return;
    const now = performance.now();
    if (what === 'click') tourTrace.clickAt = now;
    tourTrace.marks.push({ what, t: Math.round(now), sinceClick: tourTrace.clickAt ? Math.round(now - tourTrace.clickAt) : null, step: tourCard ? tourCard.step : 0 });
    if (tourTrace.marks.length > 400) tourTrace.marks.shift();
    nus.log('[tour trace] step ' + (tourCard ? tourCard.step : 0) + ' ' + what + (tourTrace.clickAt && what !== 'click' ? ' +' + Math.round(now - tourTrace.clickAt) + 'ms' : ''));
  }
  function tourSend(action, text) { if (nus.guideAsk) nus.guideAsk({ action, text: text || '' }); }
  function tourButton(a) {
    const b = document.createElement('button'); b.type = 'button'; b.textContent = a.label; if (a.primary) b.className = 'primary'; b.disabled = !!a.disabled;
    b.addEventListener('click', (e) => { e.stopPropagation(); trMark('click'); if (a.id === 'tour-desktop') { if (nus.desktopTour) nus.desktopTour(); tourSend('tour-finish'); return; } tourSend(a.id); });
    return b;
  }
  function renderTourMid(card) {
    trMid.innerHTML = ''; tourBars = null;
    const add = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text != null) el.textContent = text; trMid.appendChild(el); return el; };
    if (card.kind === 'mic') { tourBars = add('canvas', 'tr-bars'); tourBars.width = 340; tourBars.height = 56; add('div', 'tr-note tr-device', 'Microphone: ' + (card.device || micLabel() || 'the Windows default')); add('div', 'tr-mics'); renderTourMics(); }
    if (card.keys && card.keys.length) { const k = add('div', 'tr-keys'); for (const key of card.keys) { const el = document.createElement('kbd'); el.textContent = key; k.appendChild(el); } }
    if (card.chip) add('div', 'tr-chip', card.chip);
    if (card.qa) { const list = add('div', 'tr-qa'); for (const row of card.qa) { const q = document.createElement('div'); q.className = 'tr-q' + (row.current ? ' on' : ''); q.textContent = row.q; list.appendChild(q); if (row.a) { const a = document.createElement('div'); a.className = 'tr-a'; a.textContent = 'You: ' + row.a; list.appendChild(a); } } }
    // Card 5: the two homes, each a small picture of the screen with the Knot in it.
    if (card.choices) {
      const row = add('div', 'tr-choices');
      for (const c of card.choices) {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'tr-choice' + (c.on ? ' on' : ''); b.dataset.pic = c.pic || '';
        const pic = document.createElement('span'); pic.className = 'tr-pic'; pic.innerHTML = '<i></i>'; b.appendChild(pic);
        const lab = document.createElement('span'); lab.className = 'tr-choice-label'; lab.textContent = c.label; b.appendChild(lab);
        b.addEventListener('click', (e) => { e.stopPropagation(); trMark('click'); tourSend(c.id); });
        row.appendChild(b);
      }
    }
    // Card 6: the one switch, the real setting behind it.
    if (card.toggle) {
      const t = card.toggle, b = document.createElement('button'); b.type = 'button'; b.className = 'tr-switch' + (t.on ? ' on' : ''); b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(!!t.on)); b.disabled = !!t.disabled;
      b.innerHTML = '<span class="tr-switch-track"><span class="tr-switch-knob"></span></span>'; const lab = document.createElement('span'); lab.textContent = t.label; b.appendChild(lab);
      b.addEventListener('click', (e) => { e.stopPropagation(); trMark('click'); tourSend(t.id); });
      trMid.appendChild(b);
    }
    if (card.chips) { const row = add('div', 'tr-chips'); for (const t of card.chips) { const s = document.createElement('span'); s.textContent = t; row.appendChild(s); } }
    if (card.input) {
      const f = add('form', 'tr-input'); const inp = document.createElement('input'); inp.type = card.input.secret ? 'password' : 'text'; inp.placeholder = card.input.placeholder || ''; inp.maxLength = card.input.secret ? 4096 : 160; inp.spellcheck = false; inp.autocomplete = 'off';
      const b = document.createElement('button'); b.type = 'submit'; b.textContent = card.input.label || 'Send'; f.appendChild(inp); f.appendChild(b);
      f.addEventListener('submit', (e) => { e.preventDefault(); const v = inp.value.trim(); if (!v) return; inp.value = ''; trMark('click'); tourSend(card.input.action, v); });
    }
    if (card.note) add('div', 'tr-note', card.note);
  }
  function renderTourActions(actions) { trActions.innerHTML = ''; for (const a of actions || []) trActions.appendChild(tourButton(a)); }
  function renderTourHead(card) {
    // The hello card comes before the counted cards: no step, no dots.
    trKicker.textContent = card.step >= 1 ? 'Step ' + card.step + ' of ' + card.of : '';
    trDots.innerHTML = ''; if (card.step >= 1) for (let i = 1; i <= card.of; i++) { const d = document.createElement('i'); if (i === card.step) d.className = 'on'; trDots.appendChild(d); }
    renderTourProgress(card.progress);
  }
  // The voice download, a thin line under the dots while it runs.
  function renderTourProgress(p) {
    if (!p) { trProgress.classList.add('hidden'); trProgress.innerHTML = ''; return; }
    if (!trProgress.firstChild) trProgress.innerHTML = '<span class="tr-progress-label"></span><span class="tr-progress-bar"><i></i></span>';
    trProgress.querySelector('.tr-progress-label').textContent = p.label || '';
    trProgress.querySelector('.tr-progress-bar i').style.width = Math.max(0, Math.min(100, Number(p.pct) || 0)) + '%';
    trProgress.classList.remove('hidden');
  }
  // The whole card into the DOM, no motion. The morph wraps this.
  function renderTourCard(card) {
    renderTourHead(card);
    trTitle.textContent = card.title || ''; trBody.textContent = card.body || ''; trStatus.textContent = card.status || '';
    renderTourMid(card); renderTourActions(card.actions);
    trSkip.classList.toggle('hidden', !card.skip);
    tourEl.dataset.kind = card.kind || '';
  }
  function micLabel() { try { const t = micStream && micStream.getAudioTracks()[0]; return t && t.label ? t.label.replace(/^Default - /, '') : ''; } catch (_) { return ''; } }
  function placeTour() { if (isShown(tourEl) && tourIslandWant === null) placeSlot(tourEl); }
  function tourUntuck() { if (isShown(tourTuck)) hideSurface(tourTuck, null, 'hidden', { plain: true }); }

  // -- motion: the morph and the fold --
  let trAnims = [], trTimers = [];
  // Everything in flight stops here, and a fold that is stopped never finishes:
  // its timer would hide a sheet that has since come back.
  function trCancel() {
    for (const t of trTimers) clearTimeout(t);
    trTimers = [];
    for (const a of trAnims) { a.onfinish = null; try { a.cancel(); } catch (_) { /* gone */ } }
    trAnims = [];
    for (const g of tourEl.querySelectorAll('.tr-ghost')) g.remove();
    tourEl.classList.remove('is-morphing', 'is-leaving'); tourTuck.classList.remove('is-leaving');
    tourEl.style.height = ''; tourEl.style.transformOrigin = ''; tourTuck.style.transformOrigin = '';
  }
  // A ghost of what the sheet shows now, to fade out over the new content.
  function trGhost() {
    const g = document.createElement('div'); g.className = 'tr-ghost';
    for (const child of Array.from(tourEl.children)) {
      if (child.classList.contains('tr-ghost')) continue;
      const c = child.cloneNode(true); c.removeAttribute('id'); for (const el of c.querySelectorAll('[id]')) el.removeAttribute('id');
      g.appendChild(c);
    }
    // The live bars: copy the pixels, a cloned canvas is blank.
    const src = tourEl.querySelector('canvas.tr-bars'), dst = g.querySelector('canvas.tr-bars');
    if (src && dst) { try { dst.getContext('2d').drawImage(src, 0, 0); } catch (_) { /* fine */ } }
    return g;
  }
  // One card into the next: the sheet keeps its place and its glass. The
  // frame's height eases from the old content to the new, the old words fade
  // out over the new ones as they come in. Nothing is hidden at any point.
  function morphTour(apply) {
    if (!isShown(tourEl) || reducedMotion()) { trCancel(); apply(); placeTour(); return; }
    trCancel();
    const r0 = tourEl.getBoundingClientRect();
    const ghost = trGhost();
    apply();
    placeTour();
    const r1 = tourEl.getBoundingClientRect();
    tourEl.appendChild(ghost);
    tourEl.classList.add('is-morphing');
    const dx = r0.left - r1.left, dy = r0.top - r1.top;
    const frame = tourEl.animate([{ height: r0.height + 'px', transform: 'translate(' + dx + 'px,' + dy + 'px)' }, { height: r1.height + 'px', transform: 'none' }], { duration: TR.morph, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
    const fade = ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: TR.ghost, easing: 'ease-out', fill: 'forwards' });
    trAnims.push(frame, fade);
    for (const child of tourEl.children) {
      if (child === ghost || child === trSkip) continue;
      trAnims.push(child.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'none' }], { duration: TR.in, delay: 50, easing: 'cubic-bezier(.2,0,.2,1)', fill: 'backwards' }));
    }
    frame.onfinish = () => { trCancel(); placeTour(); };
  }
  // New words on the same card: only the frame moves, to the new height.
  function easeTour(apply) {
    if (!isShown(tourEl) || reducedMotion() || tourEl.classList.contains('is-morphing')) { apply(); placeTour(); return; }
    const r0 = tourEl.getBoundingClientRect();
    apply();
    placeTour();
    const r1 = tourEl.getBoundingClientRect();
    if (Math.abs(r0.height - r1.height) < 1) return;
    tourEl.classList.add('is-morphing');
    const frame = tourEl.animate([{ height: r0.height + 'px', transform: 'translate(' + (r0.left - r1.left) + 'px,' + (r0.top - r1.top) + 'px)' }, { height: r1.height + 'px', transform: 'none' }], { duration: TR.morph, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
    trAnims.push(frame);
    frame.onfinish = () => { trCancel(); placeTour(); };
  }
  // An element from one box to its own: translate and scale from the first.
  function flipFrom(el, from, to, ms, fadeIn) {
    const sx = from.width / Math.max(1, to.width), sy = from.height / Math.max(1, to.height);
    el.style.transformOrigin = '0 0';
    const a = el.animate([{ transform: 'translate(' + (from.left - to.left) + 'px,' + (from.top - to.top) + 'px) scale(' + sx + ',' + sy + ')', opacity: fadeIn ? 0 : 1 }, { transform: 'none', opacity: 1 }],
      { duration: ms, easing: 'cubic-bezier(.22,1,.36,1)', fill: 'both' });
    a.onfinish = () => { try { a.cancel(); } catch (_) { /* fine */ } el.style.transformOrigin = ''; };
    trAnims.push(a);
    return a;
  }
  // An element from its own box into another, fading, then `done`.
  function flipInto(el, from, to, ms, done) {
    const sx = to.width / Math.max(1, from.width), sy = to.height / Math.max(1, from.height);
    el.style.transformOrigin = '0 0';
    el.classList.add('is-leaving');
    const a = el.animate([{ transform: 'none', opacity: 1 }, { transform: 'translate(' + (to.left - from.left) + 'px,' + (to.top - from.top) + 'px) scale(' + sx + ',' + sy + ')', opacity: 0 }],
      { duration: ms, easing: 'cubic-bezier(.4,0,.8,1)', fill: 'both' });
    let ended = false;
    const end = () => { if (ended) return; ended = true; try { a.cancel(); } catch (_) { /* fine */ } el.classList.remove('is-leaving'); el.style.transformOrigin = ''; if (done) done(); };
    a.onfinish = end; trTimers.push(setTimeout(end, ms + 80));
    trAnims.push(a);
    return a;
  }
  // The sheet folds into the one line at the bottom left: one motion.
  function tuckTour(text, actions) {
    const rs = isShown(tourEl) ? tourEl.getBoundingClientRect() : null;
    setTourMic(false);
    fillTuck(text, actions);
    if (!isShown(tourTuck)) showSurface(tourTuck, null, 'hidden', { plain: true });
    if (!rs || reducedMotion()) { if (isShown(tourEl)) hideSurface(tourEl, () => syncSlot(), 'hidden', { plain: true }); syncSlot(); return; }
    trCancel();
    const rt = tourTuck.getBoundingClientRect();
    flipFrom(tourTuck, rs, rt, TR.fold, true);
    flipInto(tourEl, rs, rt, Math.round(TR.fold * .8), () => { hideSurface(tourEl, () => syncSlot(), 'hidden', { plain: true }); });
    syncSlot();
  }
  // The line unfolds back into the sheet, the strand reaching it at the same time.
  function untuckTour(card) {
    const rt = isShown(tourTuck) ? tourTuck.getBoundingClientRect() : null;
    trCancel();
    renderTourCard(card);
    showSurface(tourEl, placeTour, 'hidden', { plain: true });
    const rs = tourEl.getBoundingClientRect();
    if (rt && !reducedMotion()) {
      flipFrom(tourEl, rt, rs, TR.fold, true);
      flipInto(tourTuck, rt, rs, Math.round(TR.fold * .7), () => { hideSurface(tourTuck, null, 'hidden', { plain: true }); });
    } else tourUntuck();
    syncSlot(); syncKnotUi();
    tourMicAfterMotion(card);
  }
  // Opening or closing the mic takes a long frame (198 ms measured opening it),
  // so it waits until the sheet has stopped moving.
  function tourMicAfterMotion(card) {
    clearTimeout(tourMicTimer);
    tourMicTimer = setTimeout(() => { setTourMic(!!tourCard && tourCard.kind === 'mic'); }, reducedMotion() ? 0 : TR.morph + 20);
  }
  // The Knot moved house (card 5, or any island switch while a card is up): it
  // flies there, and the sheet glides after it from where it was.
  function tourFollowKnot(r0) {
    if (!tourCard || !isShown(tourEl)) return;
    placeTour();
    const r1 = tourEl.getBoundingClientRect();
    syncSlot(); syncKnotUi();
    if (reducedMotion() || (Math.abs(r0.left - r1.left) < 2 && Math.abs(r0.top - r1.top) < 2)) return;
    trCancel();
    flipFrom(tourEl, r0, r1, TR.follow, false);
  }
  function tourIslandSwitch(on) {
    const first = tourIslandWant === null;
    tourIslandWant = on;
    if (!first) return;   // a second tap while it flies: it lands, then does what was asked last
    const landed = () => {
      const r0 = tourEl.getBoundingClientRect();
      const want = tourIslandWant; tourIslandWant = null;
      if (want !== islandOn) { tourIslandSwitch(want); return; }
      tourFollowKnot(r0);
    };
    if (on) {
      const dock = { x: islandKnotX(ISLAND.idle), y: ISLAND.top + ISLAND.h / 2 };
      moveKnotTo(dock, { persist: false, keepGuide: true, onDone: () => {
        // Measured before the pill takes over: that is where the sheet glides from.
        const r0 = tourEl.getBoundingClientRect();
        const want = tourIslandWant;
        if (want) setIsland(true);
        tourIslandWant = null;
        if (!want) { tourIslandSwitch(false); return; }
        tourFollowKnot(r0);
      } });
      return;
    }
    // Back to free: the Knot stays up here until main says where its spot is
    // (knot:pos comes right after), then flies there.
    const from = knotPos ? { x: knotPos.x, y: knotPos.y } : null;
    setIsland(false);
    if (from) applyKnotPos(from);
    tourHomeHold = (payload) => {
      if (payload) applyKnotPayload(payload);
      const home = knotPos ? { x: knotPos.x, y: knotPos.y } : null;
      if (from) applyKnotPos(from);
      if (home) moveKnotTo(home, { persist: false, keepGuide: true, onDone: landed }); else landed();
    };
    setTimeout(() => { if (tourHomeHold) { const hold = tourHomeHold; tourHomeHold = null; hold(null); } }, 200);
  }

  function showTourCard(card) {
    if (!card) return;
    if (card.trace) tourTrace.on = true;
    trMark('card');
    const first = !tourCard || !isShown(tourEl);
    tourCard = card;
    hideBubble(); hideHint(); if (quickOpen) closeQuickAsk();
    noteActivity();
    if (isShown(tourTuck) && !isShown(tourEl)) { untuckTour(card); setIgnoreSafe(false); cues.play('tick'); afterTourPaint(); return; }
    if (first) {
      tourUntuck();
      renderTourCard(card);
      const wait = claimKnotSlot(tourEl);
      openSlotSurface(tourEl, placeTour, { origin: originAt(tourEl, slotPoint) }, wait);
    } else morphTour(() => renderTourCard(card));
    syncSlot(); syncKnotUi();
    setIgnoreSafe(false);
    cues.play('tick');
    tourMicAfterMotion(card);
    afterTourPaint();
  }
  function afterTourPaint() { requestAnimationFrame(() => requestAnimationFrame(() => trMark('painted'))); }
  function fillTuck(text, actions) {
    tourTuck.innerHTML = '';
    const span = document.createElement('span'); span.textContent = text || trKicker.textContent; tourTuck.appendChild(span);
    for (const a of actions || []) tourTuck.appendChild(tourButton(a));
  }
  function updateTourCard(p) {
    if (!p || !tourCard) return;
    if (p.tucked) {
      // A demo has the screen: one line at the bottom left, the sheet folded into it.
      tourCard.tuckText = p.text || tourCard.tuckText;
      tourCard.tuckActions = p.actions || tourCard.tuckActions || [];
      clearTimeout(tourMicTimer);
      tuckTour(tourCard.tuckText, tourCard.tuckActions);
      return;
    }
    if (p.tucked === false && (isShown(tourTuck) || !isShown(tourEl))) { tourCard = Object.assign({}, tourCard, p); untuckTour(tourCard); return; }
    // A choice on a card changes its words in place; the frame eases to fit.
    easeTour(() => {
      if (p.title != null) { trTitle.textContent = p.title; tourCard.title = p.title; }
      if (p.body != null) { trBody.textContent = p.body; tourCard.body = p.body; }
      if (p.status != null) { trStatus.textContent = p.status; tourCard.status = p.status; }
      if (p.chip != null) { tourCard.chip = p.chip; const chip = trMid.querySelector('.tr-chip'); if (chip) chip.textContent = p.chip; }
      if (p.progress !== undefined) { tourCard.progress = p.progress; renderTourProgress(p.progress); }
      // The two homes and the switch stay the same elements, so they slide.
      if (p.choices) { tourCard.choices = p.choices; for (const c of p.choices) { const b = trMid.querySelector('.tr-choice[data-pic="' + c.pic + '"]'); if (b) b.classList.toggle('on', !!c.on); } }
      if (p.toggle) { tourCard.toggle = p.toggle; const b = trMid.querySelector('.tr-switch'); if (b) { b.classList.toggle('on', !!p.toggle.on); b.setAttribute('aria-checked', String(!!p.toggle.on)); } }
      let mid = false;
      if (p.qa) { tourCard.qa = p.qa; mid = true; }
      if (p.input !== undefined) { tourCard.input = p.input; mid = true; }
      if (mid) renderTourMid(tourCard);
      if (p.actions) { tourCard.actions = p.actions; renderTourActions(p.actions); if (isShown(tourTuck)) fillTuck(tourCard.tuckText, p.actions); }
    });
  }
  function endTourCard(p) {
    const done = !!(p && p.reason === 'done');
    tourCard = null; clearTimeout(tourMicTimer); setTourMic(false);
    trCancel();
    if (isShown(tourEl)) hideSurface(tourEl, () => syncSlot(), 'hidden', { plain: true });
    tourUntuck();
    syncSlot(); syncKnotUi();
    setIgnoreSafe(true);
    // The two notes after the last line, never over speech.
    if (done) { let tries = 0; const t = setInterval(() => { if (!speakingNow || ++tries > 40) { clearInterval(t); cues.play('done-notes'); } }, 200); }
  }
  // The held key shows on the sheet while a card waits for words.
  function tourPtt(held) {
    if (!tourCard || !isShown(tourEl) || (tourCard.kind !== 'key' && tourCard.kind !== 'questions' && tourCard.kind !== 'guide')) return;
    trStatus.textContent = held ? 'Listening, release to send' : 'Thinking';
  }
  // The mic card: the bars are the live level; half a second of voice lights Continue.
  function setTourMic(on) {
    on = !!on;
    if (on === tourMic) return;
    tourMic = on; tourHeardMs = 0; tourLevelAt = 0; tourHeardSent = false; tourPeak = 0; tourMicAt = Date.now(); tourHelpShown = '';
    clearInterval(tourHelpTimer); tourHelpTimer = on ? setInterval(tourMicHelp, 1000) : null;
    if (on) {
      Promise.resolve(startMic()).then(() => {
        if (tourMic && !micStream) { tourMicFailed(); return; }
        // The device's own name, once the stream is up.
        const label = micLabel(), el = trMid.querySelector('.tr-device'); if (label && el && tourCard && tourCard.kind === 'mic') el.textContent = 'Microphone: ' + label;
      }).catch(tourMicFailed);
      tourBarsRaf = requestAnimationFrame(paintTourBars);
    } else { if (tourBarsRaf) cancelAnimationFrame(tourBarsRaf); tourBarsRaf = 0; if (!pttHeld && !captureOn()) stopMic(); }
  }
  function tourMicFailed() {
    if (!tourMic || !tourCard || tourCard.kind !== 'mic') return;
    nus.log('tour mic: failed (' + (micLastError || 'no stream') + '), ' + ((micFoundList && micFoundList.list.length) || 0) + ' device(s)');
    trBody.textContent = NM.failLine(micLastError);
    renderTourActions([{ id: 'tour-mic-retry', label: 'Try again', primary: true }, { id: 'tour-mic-none', label: 'Go on and type' }]);
    renderTourMics();
  }
  // The devices on the microphone card, the one in use marked. Shown when there is a choice.
  function renderTourMics() {
    const host = trMid.querySelector('.tr-mics');
    if (!host || !tourCard || tourCard.kind !== 'mic') return;
    const found = micFoundList || { list: [], defaultLabel: '' };
    host.innerHTML = '';
    if (found.list.length < 2 && !(settings && settings.micDeviceId)) return;
    const pick = NM.choose(found, settings || {});
    const rows = [{ id: '', label: 'Windows default' + (found.defaultLabel ? ' (' + found.defaultLabel + ')' : '') }].concat(found.list);
    for (const d of rows.slice(0, 6)) {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'tr-mic' + (d.id === pick.id ? ' on' : ''); b.textContent = d.label;
      b.addEventListener('click', (e) => {
        e.stopPropagation(); trMark('click');
        const patch = { micDeviceId: d.id, micDeviceLabel: d.id ? d.label : '' };
        if (settings) Object.assign(settings, patch);
        micPickSeen = d.id;
        tourHeardMs = 0; tourLevelAt = 0; tourHeardSent = false; tourPeak = 0; tourMicAt = Date.now(); tourHelpShown = '';
        Promise.resolve(nus.settingsSet(patch)).catch(() => {});
        if (micStream) reopenMic('picked on the tour'); else setTourMicAgain();
        renderTourMics();
        const el = trMid.querySelector('.tr-device'); if (el) el.textContent = 'Microphone: ' + (d.id ? d.label : (found.defaultLabel || 'the Windows default'));
      });
      host.appendChild(b);
    }
  }
  function setTourMicAgain() { if (!tourMic) return; tourMic = false; setTourMic(true); }
  // A while on the card and no voice: say why in plain words, once each kind.
  let tourPeak = 0, tourMicAt = 0, tourHelpShown = '', tourHelpTimer = null;
  function tourMicHelp() {
    if (!tourMic || !tourCard || tourCard.kind !== 'mic' || !micStream) return;
    const kind = NM.verdict(Date.now() - tourMicAt, tourHeardSent, tourPeak);
    if (!kind || kind === tourHelpShown) return;
    tourHelpShown = kind;
    const others = ((micFoundList && micFoundList.list.length) || 0) > 1;
    nus.log('tour mic: ' + kind + ' after ' + Math.round((Date.now() - tourMicAt) / 1000) + ' s on ' + (micLabel() || 'the default') + ', peak ' + tourPeak.toFixed(4) + ', ' + ((micFoundList && micFoundList.list.length) || 0) + ' device(s)');
    trStatus.textContent = NM.helpLine(kind, micLabel(), others);
    if (kind === 'dead' || !others) renderTourActions([{ id: 'tour-next', label: 'Continue', primary: true, disabled: true }, { id: 'tour-mic-none', label: 'Go on and type' }]);
    renderTourMics();
  }
  function tourLevel(level) {
    const v = Math.min(1, Math.max(0, (level || 0) * 7)), now = Date.now();
    if ((level || 0) > tourPeak) tourPeak = level || 0;
    tourLevels.push(v); tourLevels.shift();
    // The bars move for anything; only the person counts, not the Knot's own line.
    if (speakingNow) { tourHeardMs = 0; tourLevelAt = 0; return; }
    if (v > .22) { if (tourLevelAt) tourHeardMs += Math.min(60, now - tourLevelAt); tourLevelAt = now; }
    else if (now - tourLevelAt > 400) tourLevelAt = 0;
    if (tourHeardMs >= 500 && !tourHeardSent) { tourHeardSent = true; tourSend('tour-mic-heard'); }
  }
  function paintTourBars() {
    tourBarsRaf = tourMic ? requestAnimationFrame(paintTourBars) : 0;
    if (!tourBars) return;
    const ctx = tourBars.getContext('2d'), w = tourBars.width, h = tourBars.height, n = tourLevels.length, gap = 4, bw = (w - gap * (n - 1)) / n;
    ctx.clearRect(0, 0, w, h); ctx.fillStyle = '#fff';
    for (let i = 0; i < n; i++) { const env = Math.sin((i + .5) / n * Math.PI), bh = Math.max(3, h * (.08 + .9 * tourLevels[i] * (.35 + .65 * env))); ctx.fillRect(i * (bw + gap), (h - bh) / 2, bw, bh); }
  }
  trSkip.addEventListener('click', (e) => { e.stopPropagation(); tourSend('tour-skip'); });
  nus.on('tour:card', showTourCard);
  nus.on('tour:update', updateTourCard);
  nus.on('tour:end', endTourCard);
  $('#logo-btn').addEventListener('click', () => tourSend('tour-start'));
  nus.on('tour:start', () => tourSend('tour-start'));
  // Read and drive handles for the CDP checks and captures, like __nusMotion.
  window.__nusTour = { get card() { return tourCard; }, get trace() { return tourTrace.marks; }, mark: trMark, get shown() { return isShown(tourEl); }, get tucked() { return isShown(tourTuck); }, get speaking() { return speakingNow; }, get level() { return tourLevels[tourLevels.length - 1]; }, get heardMs() { return tourHeardMs; } };

  // Desktop link tick: lit when the desktop's shared context is present.
  async function syncDesktopLink() {
    if (!settings || standalone) return;
    try {
      const status = await nus.nusContextStatus();
      $('#desktop-link').classList.toggle('off', !status.ok);
    } catch (_) { /* preview stub */ }
  }
  syncDesktopLink();
  setInterval(syncDesktopLink, 120000);

  // ---- where the Knot lives ----------------------------------------------
  // The Knot sits anywhere on the screen: dragged there, remembered per
  // display as fractions of the work area, never following the cursor. The
  // stack (sheet, capsule, tiles) hugs whichever quadrant it is in, so every
  // corner rule keeps working; `data-corner` now means "which quadrant".
  // It sits upright everywhere; the loose end leaves toward whatever it
  // points at, so nothing here turns the mark.
  const appEl = $('#app');
  const CORNERS = new Set(['tl', 'tr', 'bl', 'br']);
  let corner = 'br';
  let knotPos = null;       // { x, y } CSS px, the Knot's centre
  const KNOT_MARGIN = KSPEC.host.clampMargin;   // half the orb plus a breath
  function cornerToPos(c) {
    const W = window.innerWidth, H = window.innerHeight;
    return { x: /r$/.test(c) ? W - 62 : 62, y: /^b/.test(c) ? H - 54 : 54 };
  }
  function clampPos(p) {
    const W = window.innerWidth, H = window.innerHeight;
    // Whole pixels: a mark drawn on a fraction of a pixel is resampled and goes soft.
    return { x: Math.round(Math.max(KNOT_MARGIN, Math.min(W - KNOT_MARGIN, p.x))), y: Math.round(Math.max(KNOT_MARGIN, Math.min(H - KNOT_MARGIN, p.y))) };
  }
  // Everything that hangs off the Knot follows it: the thread is laid again
  // from the new seam and whatever sits in its slot moves with it.
  function followKnot() {
    if (strand) strand.relayout(strand.surfaceOut() ? slotPoint() : null);
    positionBubble(); placeByKnot(keepChip); placeByKnot(quickAsk); placeByKnot($('#knot-hint')); if (tourIslandWant === null) placeByKnot($('#tour'));
  }
  // Place the stack so the orb's centre lands on (x, y): pick the quadrant,
  // set the padding on the far sides, then measure and correct once so the
  // 4 px of toolbar and shell chrome never put it off by a hair.
  function applyKnotPos(p, opts = {}) {
    if (!p) return;
    if (islandOn && !opts.dock) { dockKnot(opts); return; }
    knotPos = opts.dock ? { x: Math.round(p.x), y: Math.round(p.y) } : clampPos(p);
    if (!opts.dock) appEl.style.translate = '';
    const W = window.innerWidth, H = window.innerHeight;
    const q = (knotPos.y < H / 2 ? 't' : 'b') + (knotPos.x < W / 2 ? 'l' : 'r');
    corner = q;
    appEl.dataset.corner = q;
    const pad = { l: 0, r: 0, t: 0, b: 0 };
    if (q.endsWith('l')) pad.l = knotPos.x - 40; else pad.r = W - knotPos.x - 40;
    if (q.startsWith('t')) pad.t = knotPos.y - 40; else pad.b = H - knotPos.y - 40;
    const setPad = () => { appEl.style.padding = Math.max(0, pad.t) + 'px ' + Math.max(0, pad.r) + 'px ' + Math.max(0, pad.b) + 'px ' + Math.max(0, pad.l) + 'px'; };
    setPad();
    const r = $('#orb').getBoundingClientRect();
    if (r.width) {
      const dx = knotPos.x - (r.left + r.width / 2), dy = knotPos.y - (r.top + r.height / 2);
      if (q.endsWith('l')) pad.l += dx; else pad.r -= dx;
      if (q.startsWith('t')) pad.t += dy; else pad.b -= dy;
      setPad();
      // Docked in the pill the Knot sits higher than the stack's padding can
      // reach (it stops at 0): the last few pixels ride a translate.
      if (opts.dock) {
        appEl.style.translate = '';
        const r1 = $('#orb').getBoundingClientRect();
        const ry = knotPos.y - (r1.top + r1.height / 2), rx = knotPos.x - (r1.left + r1.width / 2);
        if (Math.abs(ry) > 0.5 || Math.abs(rx) > 0.5) appEl.style.translate = rx.toFixed(2) + 'px ' + ry.toFixed(2) + 'px';
      }
      // The window is not always a whole number of pixels wide, so the laid-out
      // orb can sit on a fraction: nudge the canvas the last bit onto the grid.
      const r2 = $('#orb').getBoundingClientRect(), cv = $('#knot-canvas');
      if (cv) cv.style.translate = (Math.round(r2.left) - r2.left).toFixed(3) + 'px ' + (Math.round(r2.top) - r2.top).toFixed(3) + 'px';
    }
    if (knot3d && knot3d.redraw && !(knot3d.isAsleep && knot3d.isAsleep())) knot3d.redraw();
    if (!opts.silent) requestAnimationFrame(followKnot);
    if (opts.persist && !opts.dock && nus.knotPosSet) Promise.resolve(nus.knotPosSet({ fx: knotPos.x / W, fy: knotPos.y / H })).catch(() => {});
    // Main reads the brightness behind the Knot; tell it where that is.
    if (!opts.silent && nus.knotAt) { const z = Math.pow(1.2, (nus.getZoomLevel && nus.getZoomLevel()) || 0); nus.knotAt({ x: knotPos.x * z, y: knotPos.y * z }); }
  }
  function applyKnotPayload(p) {
    // On its way back from the island in the tour: this says where it is flying to.
    if (tourHomeHold) { const hold = tourHomeHold; tourHomeHold = null; hold(p); return; }
    if (p && Number.isFinite(p.fx) && Number.isFinite(p.fy)) {
      const next = clampPos({ x: p.fx * window.innerWidth, y: p.fy * window.innerHeight });
      // A changed screen moved its spot: it travels there instead of jumping.
      if (p.skate && knotPos && Math.hypot(next.x - knotPos.x, next.y - knotPos.y) >= KSPEC.host.skater.minDistance) moveKnotTo(next, { persist: false });
      else applyKnotPos(next);
    } else applyCorner((p && p.corner) || 'br', false);
  }
  function applyCorner(next, persist) {
    if (!CORNERS.has(next)) next = 'br';
    applyKnotPos(cornerToPos(next));
    if (persist && nus.knotCornerSet) Promise.resolve(nus.knotCornerSet(next)).catch(() => {});
  }
  nus.on('knot:corner', (p) => applyCorner(p && p.corner, false));
  nus.on('knot:pos', applyKnotPayload);
  window.addEventListener('resize', () => requestAnimationFrame(() => { if (knotPos) applyKnotPos(knotPos); }));

  // ---- the whole Knot travelling --------------------------------------------
  // Being sent somewhere on purpose (a corner picked from the menu, a screen that
  // changed, being told to move) and every step of a walkthrough, which it flies
  // to and lassos. Hands and the pill keep the thread.
  // In flight the orb rides a transform from where it was laid out, and the
  // layout is committed once on landing, so nothing reflows mid-air and the
  // stack never flips corner halfway.
  let skateHome = null;      // where it lives, while it has stepped aside
  let lastSpot = null;       // where it was before it was last sent somewhere ("go back")
  function moveKnotTo(dest, opts = {}) {
    const done = () => { if (opts.onDone) opts.onDone(); };
    if (islandOn) { dockKnot(); done(); return false; }
    if (!knot3d || !knot3d.travelTo || !knotPos) { applyKnotPos(dest, { persist: !!opts.persist }); done(); return false; }
    const flying = knot3d.isTravelling();
    if (dragging || (flying && !opts.lasso && !opts.retarget)) { done(); return false; }
    const to = clampPos(dest);
    if (!opts.lasso && !flying && Math.hypot(to.x - knotPos.x, to.y - knotPos.y) < KSPEC.host.skater.minDistance) {
      // Too near to be a journey: it is simply there, with a small settle.
      applyKnotPos(to, { persist: !!opts.persist });
      if (knot3d.gesture) knot3d.gesture('settle');
      done();
      return false;
    }
    // Nothing rides along: surfaces close and a surface thread comes home first.
    if (quickOpen) closeQuickAsk();
    hideHint(); clearTimeout(keepTimer); hideSurface(keepChip);
    if (isShown(panel, 'collapsed')) hideTiles();
    if (!opts.keepGuide) { hideBubble(); pendingBubble = null; }
    // A flight can hold this page up for its whole length (sampled live 2026-11-03:
    // 1 to 3 s), so the mouse goes back to the screen before it starts.
    const at = pointerAt || { x: -1, y: -1 };
    if (!overUIAt(at.x, at.y)) setIgnoreSafe(true);
    noteActivity();
    const from = { x: knotPos.x, y: knotPos.y };
    appEl.classList.add('skating');
    strand.setCallbacks({ place(pos, final) {
      if (final) {
        // Landing: drop the ride and commit the layout in one step. The
        // "skating" class (no transitions) stays on until the next frame, so
        // the measure inside applyKnotPos sees the orb where it really is.
        orbEl.style.transform = '';
        applyKnotPos(pos, { persist: !!opts.persist });
        requestAnimationFrame(() => appEl.classList.remove('skating'));
      } else orbEl.style.transform = 'translate(' + (pos.x - from.x).toFixed(2) + 'px,' + (pos.y - from.y).toFixed(2) + 'px)';
    } });
    // Sent somewhere on purpose: it acknowledges, then goes. (Stepping aside
    // inside a guide already acknowledged the ask.)
    if (!opts.keepGuide) { ack(); clearAck(); syncKnotUi(); }
    cues.play(opts.lasso ? 'reach' : 'skate');
    return knot3d.travelTo(to, { onDone: done, lasso: opts.lasso || null, region: opts.region || null });
  }
  // Main (the tray menu, Home, a voice command) asks the Knot to move.
  nus.on('knot:move', (p) => {
    if (!p) return;
    if (play && play.active) stopPlay('task');
    // "Go back": to where it was before it was last sent somewhere.
    if (p.home) {
      if (skateHome) { stepHome(); return; }
      if (lastSpot && knotPos) { const back = lastSpot; lastSpot = { x: knotPos.x, y: knotPos.y }; if (guideActive()) dismissGuide('move'); moveKnotTo(back, { persist: true }); }
      else if (knot3d && knot3d.gesture) { knot3d.gesture('nudge'); cues.play('nudge'); }
      return;
    }
    const to = CORNERS.has(p.corner) ? cornerToPos(p.corner) : (Number.isFinite(p.fx) && Number.isFinite(p.fy) ? { x: p.fx * window.innerWidth, y: p.fy * window.innerHeight } : null);
    if (!to) return;
    if (guideActive()) dismissGuide('move');
    skateHome = null;
    if (knotPos) lastSpot = { x: knotPos.x, y: knotPos.y };
    moveKnotTo(to, { persist: true });
  });
  // "Make yourself smaller / bigger / normal": the mark is drawn at one of
  // three scales; main keeps the choice like the spot.
  const KNOT_SCALES = { small: 0.7, normal: 1, big: 1.35 };
  let lastKnotSize = 'normal';
  function applyKnotSize(size, animate) {
    lastKnotSize = size;
    const scale = islandOn ? ISLAND.scale : (KNOT_SCALES[size] || 1);
    const orb = $('#orb');
    orb.classList.toggle('sizing', !!animate);
    orb.style.setProperty('--knot-scale', String(scale));
    orb.dataset.size = KNOT_SCALES[size] ? size : 'normal';
    if (animate) {
      if (knot3d && knot3d.gesture) knot3d.gesture('settle');
      setTimeout(() => { orb.classList.remove('sizing'); requestAnimationFrame(followKnot); }, 320);
    }
    if (knot3d && knot3d.redraw && !(knot3d.isAsleep && knot3d.isAsleep())) knot3d.redraw();
  }
  nus.on('knot:size', (p) => { if (p) applyKnotSize(p.size, p.animate !== false); });
  // Stepping aside: if the Knot is sitting on what it has to point at, it
  // skates clear first, and comes back when the guide ends. Not remembered.
  function clearSpotFor(rect) {
    if (!knotPos || islandOn) return null;
    const pad = 64, W = window.innerWidth, H = window.innerHeight;
    const hit = knotPos.x > rect.x - pad && knotPos.x < rect.x + rect.w + pad && knotPos.y > rect.y - pad && knotPos.y < rect.y + rect.h + pad;
    if (!hit) return null;
    const gap = 120;
    const options = [
      { x: rect.x - gap, y: knotPos.y }, { x: rect.x + rect.w + gap, y: knotPos.y },
      { x: knotPos.x, y: rect.y - gap }, { x: knotPos.x, y: rect.y + rect.h + gap },
    ].filter((o) => o.x >= KNOT_MARGIN && o.x <= W - KNOT_MARGIN && o.y >= KNOT_MARGIN && o.y <= H - KNOT_MARGIN);
    if (!options.length) return null;
    options.sort((a, b) => Math.hypot(a.x - knotPos.x, a.y - knotPos.y) - Math.hypot(b.x - knotPos.x, b.y - knotPos.y));
    return options[0];
  }
  // Where it lands to lasso a control: just off it, on the side it is coming from.
  function spotBeside(rect) {
    const gap = KSPEC.character.lasso.landing, W = window.innerWidth, H = window.innerHeight, cx = rect.x + rect.w / 2, cy = rect.y + rect.h / 2;
    const options = [
      { x: rect.x - gap, y: cy + 14 }, { x: rect.x + rect.w + gap, y: cy + 14 },
      { x: cx - 14, y: rect.y - gap }, { x: cx - 14, y: rect.y + rect.h + gap },
    ].filter((o) => o.x >= KNOT_MARGIN && o.x <= W - KNOT_MARGIN && o.y >= KNOT_MARGIN && o.y <= H - KNOT_MARGIN);
    const from = knotPos || { x: 0, y: 0 };
    options.sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y));
    return options[0] || { x: cx, y: cy };
  }
  function stepHome() {
    if (!skateHome) return;
    const home = skateHome; skateHome = null;
    moveKnotTo(home, { persist: false, retarget: true });
  }

  // ---- the focus guard, as the Knot shows it --------------------------------
  // Main runs the guard ("keep me off Reels"). On a close it hops to the top
  // edge of the browser window first (the move is issued inside this handler,
  // before the engine's next tick, so it is on screen as the tab goes), wears
  // coral while the guard is on, flashes green when it lets go, then steps
  // back to where it lived. Not persisted: the hop is a step aside.
  let guardTimer = null;
  function setGuardGlow(v) {
    guardGlow = v || null;
    if (guardGlow) $('#orb').dataset.guard = guardGlow; else delete $('#orb').dataset.guard;
    syncKnotUi();
  }
  nus.on('focus:guard', (p) => {
    if (!p) return;
    clearTimeout(guardTimer);
    if (p.phase === 'hop') {
      if (play && play.active) stopPlay('task');
      setGuardGlow('active');
      const r = p.rect;
      if (r && knotPos && !dragging && Number.isFinite(r.x) && Number.isFinite(r.w)) {
        // The window's top right edge, kept inside the overlay.
        const to = clampPos({ x: r.x + r.w - 72, y: r.y + 28 });
        if (!skateHome) skateHome = { x: knotPos.x, y: knotPos.y };
        moveKnotTo(to, { persist: false });
      } else if (knot3d && knot3d.gesture) knot3d.gesture('acknowledge');
      return;
    }
    if (p.phase === 'active') { setGuardGlow('active'); return; }
    if (p.phase === 'done') {
      setGuardGlow('done');
      if (knot3d && knot3d.gesture) knot3d.gesture('done');
      guardTimer = setTimeout(() => { setGuardGlow(null); stepHome(); }, 2600);
      return;
    }
    setGuardGlow(null);
    stepHome();
  });

  // Drag the Knot: press, move past 4 px, and it follows; release and it stays
  // there (persisted per display). The click that would follow is swallowed.
  // While dragging the window must stay clickable: overUIAt says so, because
  // the probe would otherwise hand the mouse back to the desktop the moment
  // the pointer left the 72 px orb and the drag would die.
  // It leans with the speed of the hand, settles on release, and stays exactly
  // where it was dropped. Whatever hangs off it (thread, bubble) comes along.
  let dragging = false, suppressClick = false, dragStart = null, dragRaf = null, dragLast = null;
  const orbEl = $('#orb');
  orbEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (knot3d && knot3d.isTravelling && knot3d.isTravelling()) return;
    // In the game the hand takes it mid-air, from wherever it is.
    let from = knotPos;
    if (play && play.active) { from = play.position() || knotPos; play.press(from); playRide = { rot: playRide.rot, sx: 1, sy: 1 }; }
    dragStart = { x: e.clientX, y: e.clientY, kx: from ? from.x : e.clientX, ky: from ? from.y : e.clientY, id: e.pointerId, lx: e.clientX, ly: e.clientY, lt: performance.now(), vx: 0, vy: 0 };
    try { orbEl.setPointerCapture(e.pointerId); } catch (_) { /* preview */ }
  });
  orbEl.addEventListener('pointermove', (e) => {
    if (!dragStart || e.pointerId !== dragStart.id) return;
    const dx = e.clientX - dragStart.x, dy = e.clientY - dragStart.y;
    if (!dragging) {
      if (Math.hypot(dx, dy) < 4) return;
      dragging = true; appEl.classList.add('dragging'); skateHome = null; noteActivity();
      // A held surface lets go of the strand while everything moves.
      if (strand) strand.setHeld(false);
    }
    // Speed of the hand in px per second, from timestamps.
    const now = performance.now(), dt = Math.max(KSPEC.inline.drag.minDt, (now - dragStart.lt) / 1000);
    const vx = (e.clientX - dragStart.lx) / dt, vy = (e.clientY - dragStart.ly) / dt;
    dragStart.lx = e.clientX; dragStart.ly = e.clientY; dragStart.lt = now; dragStart.vx = vx; dragStart.vy = vy;
    dragLast = { x: dragStart.kx + dx, y: dragStart.ky + dy };
    if (knot3d && knot3d.setDrag) knot3d.setDrag({ vx, vy });
    if (play && play.active) {
      // The throw is the hand's average speed over its last stretch, not one jittery sample.
      const sm = dragStart.samples || (dragStart.samples = []);
      sm.push({ t: now, x: e.clientX, y: e.clientY });
      while (sm.length > 2 && now - sm[0].t > KSPEC.host.play.throwWindowMs) sm.shift();
      const at = clampPos(dragLast); play.dragTo(at); ridePlay(at);
      return;
    }
    if (!dragRaf) dragRaf = requestAnimationFrame(() => {
      dragRaf = null;
      if (!dragLast) return;
      applyKnotPos({ x: dragLast.x, y: dragLast.y }, { silent: true });
      followKnot();
    });
  });
  function endDrag(e) {
    if (!dragStart) return;
    const was = dragging;
    if (play && play.active) {
      // Let go in a game: the hand's last speed is the throw.
      const ds = dragStart, at = play.position();
      dragStart = null; dragging = false; dragLast = null;
      if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = null; }
      appEl.classList.remove('dragging');
      if (was) { suppressClick = true; setTimeout(() => { suppressClick = false; }, 0); }
      let v = { x: ds.vx, y: ds.vy };
      const sm = ds.samples || [];
      if (sm.length >= 2) { const a = sm[0], z = sm[sm.length - 1], span = Math.max(8, z.t - a.t) / 1000; v = { x: (z.x - a.x) / span, y: (z.y - a.y) / span }; }
      play.release(at, v, performance.now() - ds.lt);
      // Out of the hand: the Knot is no longer dragged. Left on, the engine kept the
      // dragged look for the rest of the game, its tail chasing every bounce.
      if (knot3d && knot3d.setDrag) knot3d.setDrag(null);
      return;
    }
    dragStart = null; dragging = false; dragLast = null;
    if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = null; }
    appEl.classList.remove('dragging');
    if (!was) return;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 0);
    applyKnotPos(knotPos, { persist: true });
    if (knot3d && knot3d.setDrag) knot3d.setDrag(null);
    if (knot3d && knot3d.gesture) knot3d.gesture('settle');
    cues.play('settle');
    syncSlot();
    // The pointer may now be off the orb: let the probe decide the mouse.
    if (e && !overUIAt(e.clientX, e.clientY)) setIgnore(true);
    releaseKeys();
    if (nus.noteMouse) { const k = knotCentre(); nus.noteMouse({ by: 'dragged', x: k.x, y: k.y, knotX: k.x, knotY: k.y }); }
  }
  orbEl.addEventListener('pointerup', endDrag);
  orbEl.addEventListener('pointercancel', endDrag);
  orbEl.addEventListener('lostpointercapture', () => { if (dragging) endDrag(null); });

  // ---- play: hoops (play.js) ------------------------------------------------
  // Started on purpose from the Knot's menu or the tray, never in the middle of a
  // task, and any task ends it on the spot (stopPlay('task') above). While a game
  // is on the whole screen holds the mouse, so a missed grab never clicks the app
  // underneath; the score line's x, a right click or 40 s untouched ends it.
  // In play the Knot rides a transform from where it lives (like a flight), so
  // nothing reflows each frame, and its home is never overwritten.
  let playHome = null, playFx = null, playSound = null;
  // The Knot in play: where it is, plus its spin and the squash of its last
  // impact. Held in the hand it keeps the spin it had and loses the squash.
  let playRide = { rot: 0, sx: 1, sy: 1 };
  function ridePlay(at) {
    if (!knotPos || !at) return;
    if (at.rot != null) playRide = { rot: at.rot, sx: at.sx || 1, sy: at.sy || 1 };
    const r = playRide;
    orbEl.style.transform = 'translate(' + (at.x - knotPos.x).toFixed(2) + 'px,' + (at.y - knotPos.y).toFixed(2) + 'px) scale(' + r.sx.toFixed(3) + ',' + r.sy.toFixed(3) + ') rotate(' + r.rot.toFixed(3) + 'rad)';
  }
  // '' when the Knot is free to play, otherwise why not.
  function playBlocker() {
    if (!window.NusPlay || !knot3d || !knotPos) return 'unavailable';
    if (islandOn) return 'island';
    if (reducedMotion()) return 'reduced-motion';
    if (guideActive() || busy || pttHeld || captureOn() || speakingNow || handsState.active || modalOpen() || tourCard || dragging || fileDragActive) return 'busy';
    if (knot3d.isTravelling && knot3d.isTravelling()) return 'busy';
    return '';
  }
  function playStore() {
    return {
      get(k) { try { return window.localStorage.getItem('nus.' + k); } catch (_) { return null; } },
      set(k, v) { try { window.localStorage.setItem('nus.' + k, v); } catch (_) { /* private storage */ } },
    };
  }
  function makePlay() {
    if (play || !window.NusPlay) return play;
    const bounds = () => ({ w: window.innerWidth, h: window.innerHeight, m: KNOT_MARGIN });
    // What it looks like and sounds like. Both are made here, on the first game,
    // and hold nothing between games (play-fx.js, play-sound.js).
    const pal = (KSPEC.character && KSPEC.character.accent && KSPEC.character.accent.palette) || { idle: '#F5F5F7', listening: '#C58AFF', thinking: '#FFC76A', speaking: '#59B9FF', done: '#72DDA8', error: '#FF706B' };
    playFx = window.NusPlayFx ? window.NusPlayFx.create({ doc: document, view: window, spec: KSPEC.host.play, palette: pal, font: getComputedStyle(document.body).fontFamily }) : null;
    // Silent with Sound cues off, while the mic is live or the Knot speaks.
    playSound = window.NusPlaySound ? window.NusPlaySound.create({ enabled: () => cues.isEnabled() && !pttHeld && !speakingNow && !captureOn() }) : null;
    play = window.NusPlay.create({ doc: document, spec: KSPEC.host.play, host: {
      now: () => performance.now(),
      raf: (fn) => requestAnimationFrame(fn),
      caf: (id) => cancelAnimationFrame(id),
      bounds,
      place: ridePlay,
      lean: (v) => { if (knot3d && knot3d.setDrag) knot3d.setDrag(v ? { vx: v.vx, vy: v.vy } : null); },
      emit: (e) => {
        if (playFx) { if (e.type === 'start') playFx.start(); playFx.event(e); if (e.type === 'stop') playFx.stop(); }
        if (playSound) playSound.event(e);
      },
      draw: (dt, v) => (playFx ? playFx.draw(dt, v, bounds()) : false),
      gesture: (name) => { if (knot3d && knot3d.gesture) knot3d.gesture(name); },
      store: playStore(),
      log: (line) => nus.log(line),
      onEnd: endPlay,
    } });
    window.__nusPlay = play;
    return play;
  }
  function startPlay() {
    const why = playBlocker();
    if (why) {
      nus.log('[play] not now: ' + why);
      if (why === 'busy') showHint({ text: 'Let me finish this first, then we can play.', ms: 2600 });
      // The game stays off with the system's reduce-motion setting on; say so
      // instead of doing nothing (the Mac CI runner has it on, 2026-11-16).
      if (why === 'reduced-motion') showHint({ text: nus.platform === 'darwin' ? 'Hoops needs motion. Turn off Reduce motion in System Settings > Accessibility > Display to play.' : 'Hoops needs motion. Turn on Animation effects in Settings > Accessibility > Visual effects to play.', ms: 6000 });
      return false;
    }
    if (!makePlay()) return false;
    if (play.active) return true;
    if (quickOpen) closeQuickAsk();
    if (knotMenu) knotMenu.close();
    if (knotPanel && knotPanel.open) knotPanelShut();
    hideHint(); hideBubble(); pendingBubble = null; clearTimeout(keepTimer); hideSurface(keepChip);
    if (isShown(panel, 'collapsed')) hideTiles();
    releaseKeys();
    skateHome = null;
    playHome = { x: knotPos.x, y: knotPos.y };
    playRide = { rot: 0, sx: 1, sy: 1 };
    appEl.classList.add('skating');
    noteActivity();
    play.start({ x: knotPos.x, y: knotPos.y });
    setIgnoreSafe(false);
    return true;
  }
  function stopPlay(reason) { if (play && play.active) play.stop(reason); }
  // The game is over: the Knot goes home. A task is waiting, so it is simply
  // there at once; otherwise it flies back.
  function endPlay(reason, at) {
    const home = playHome || knotPos;
    playHome = null;
    orbEl.style.transform = '';
    if (knot3d && knot3d.setDrag) knot3d.setDrag(null);
    if (reason === 'task' || !at || !home) {
      appEl.classList.remove('skating');
      if (home) applyKnotPos(home);
      if (knot3d && knot3d.gesture) knot3d.gesture('settle');
    } else {
      // Commit where it landed, then fly home from there.
      applyKnotPos(at);
      requestAnimationFrame(() => { appEl.classList.remove('skating'); moveKnotTo(home, { persist: false, retarget: true }); });
    }
    const p = pointerAt || { x: -1, y: -1 };
    setIgnore(!overUIAt(p.x, p.y));
    armSleep();
  }
  nus.on('play:start', () => startPlay());
  // A tour card or Hands taking the mouse is a task too.
  nus.on('tour:card', () => stopPlay('task'));
  nus.on('hands:state', (p) => { if (p && p.active) stopPlay('task'); });
  document.addEventListener('contextmenu', (e) => { if (play && play.active) { e.preventDefault(); e.stopPropagation(); stopPlay('user'); } }, true);

  // ---- drop a file on the Knot -------------------------------------------
  // The window is click-through until the cursor probe finds the Knot under
  // a dragged file; from then on the whole window accepts the drag until it
  // drops or leaves. The Knot loosens and leans toward the file, gulps on the
  // drop, then thinks, and the composer opens to ask about the file.
  let fileDragTimer = null;
  const hasFiles = (e) => !!(e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files'));
  function fileDragOn(e) {
    if (!fileDragActive) {
      fileDragActive = true;
      appEl.classList.add('file-drag');
      setIgnore(false);
      noteActivity();
    }
    if (knot3d && knot3d.setFileHover && e) knot3d.setFileHover({ x: e.clientX, y: e.clientY });
    clearTimeout(fileDragTimer);
    fileDragTimer = setTimeout(fileDragOff, 1500);
  }
  function fileDragOff() {
    clearTimeout(fileDragTimer);
    if (!fileDragActive) return;
    fileDragActive = false;
    appEl.classList.remove('file-drag');
    if (knot3d && knot3d.setFileHover) knot3d.setFileHover(null);
  }
  document.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); fileDragOn(e); });
  document.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; fileDragOn(e); });
  document.addEventListener('dragleave', (e) => { if (e.relatedTarget == null) fileDragOff(); });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    fileDragOff();
    if (!f) return;
    let p = '';
    try { p = nus.filePath ? nus.filePath(f) : ''; } catch (_) { p = ''; }
    if (!p) { showHint({ text: 'Could not read that file', ms: 3000 }); return; }
    // One gesture at a time: here the gulp is the acknowledgement. Thinking
    // follows when the gulp has finished.
    if (knot3d && knot3d.gesture) knot3d.gesture('gulp');
    cues.play('gulp');
    lastAckAt = Date.now();
    setTimeout(holdWorking, Math.round(KSPEC.gestures.gulp.duration * 1000));
    if (nus.fileAsk) nus.fileAsk({ path: p, name: f.name });
  });

  // ---- the strand: guide sessions on screen ----------------------------
  // Main owns the session and its state machine; this side draws. A target
  // arrives in window DIPs, the thread reaches to it, the bubble opens out of
  // the tip once it lands, and any dismissal winds the thread back first.
  const strandCanvas = $('#strand-layer');
  const bubble = $('#guide-bubble');
  const keepChip = $('#keep-chip');
  let guideTask = '';
  let pendingBubble = null;   // shown when the tip arrives
  let bubbleAnchor = 'knot';
  let afterRewind = null;
  let keepSession = null, keepTimer = null;
  let targetSeq = null;       // which guide:target the thread is flying to
  let retractOnly = false;    // the thread comes back but the session goes on

  const strand = engine ? engine.thread : null;
  if (strand) strand.setCallbacks({
    // The tip has landed (the tap plays on while the bubble opens).
    onArrive() {
      cues.play('arrive'); if (knot3d && knot3d.gesture) knot3d.gesture('arrive');
      if (pendingBubble) { showBubble(pendingBubble); pendingBubble = null; }
      if (guideState === 'unwinding') setGuideState('pointing');
      if (nus.strandArrived) nus.strandArrived(targetSeq);
    },
    onRewound() {
      if (guideTask === 'solve') { afterRewind = null; retractOnly = false; return; }
      // A quick pick the model withdrew: only the thread goes home. The bubble
      // main sent next (its explanation) and the Knot's state stay as they are.
      if (retractOnly) { retractOnly = false; syncSlot(); return; }
      hideBubble();
      const f = afterRewind; afterRewind = null;
      endGuide(f);
    },
    cue(name) { cues.play(name); },
  });

  function zoomFactor() { return Math.pow(1.2, (nus.getZoomLevel && nus.getZoomLevel()) || 0); }
  function dipRectToCss(r) { const z = zoomFactor(); return { x: r.x / z, y: r.y / z, w: r.w / z, h: r.h / z }; }
  function guideActive() { return !!guideState || !!(strand && strand.getState() !== 'idle'); }

  function setGuideState(state, task) {
    const was = guideState;
    guideState = state || null;
    if (task) guideTask = task;
    // An ask that main started gets its acknowledgement on the first sign of work.
    if (!was && (guideState === 'reading' || guideState === 'thinking' || guideState === 'transcribing')) ensureAck();
    clearAck();
    watchWork(guideState);
    const orb = $('#orb');
    if (guideState) orb.dataset.state = guideState; else delete orb.dataset.state;
    syncKnotUi();
    syncSlot();
  }
  // The guide is over. If the Knot stepped aside for it, it goes home first.
  function endGuide(after) {
    setGuideState(null);
    clearCircle(); lastTargetRect = null;
    if (skateHome) { const home = skateHome; skateHome = null; moveKnotTo(home, { persist: false, retarget: true, onDone: () => { if (after) after(); } }); }
    else if (after) after();
  }

  // The corner a surface by the Knot opens from, which is also where the
  // thread's tip goes: diagonally off the Knot, toward the middle of the screen.
  function knotAnchor() {
    // Straight down from the Knot, so the thread never crosses the pill's words.
    if (islandOn) { const b = islandBox(); return { x: window.innerWidth / 2, y: b.bottom + ISLAND.drop, dx: -1, dy: 1 }; }
    const r = $('#orb').getBoundingClientRect(), A = KSPEC.inline.surface;
    const kx = r.left + r.width / 2, ky = r.top + r.height / 2;
    const dx = window.innerWidth / 2 > kx ? 1 : -1, dy = window.innerHeight / 2 > ky ? 1 : -1;
    return { x: kx + dx * (A.offsetX + A.anchorInset), y: ky + dy * A.offsetY, dx, dy };
  }
  function slotPoint() { const a = knotAnchor(); return { x: a.x, y: a.y }; }
  // Transform origin for an element whose opening point is `tip` (viewport px).
  const originAt = (el, tip) => () => { const p = typeof tip === 'function' ? tip() : tip; return p ? { x: p.x - (parseFloat(el.style.left) || 0), y: p.y - (parseFloat(el.style.top) || 0) } : null; };
  function placeAt(el, ax, ay, dx, dy) {
    const W = window.innerWidth, H = window.innerHeight;
    const bw = el.offsetWidth, bh = el.offsetHeight;
    let left = dx >= 0 ? ax : ax - bw;
    let top = dy >= 0 ? ay : ay - bh;
    left = Math.max(8, Math.min(W - bw - 8, left));
    top = Math.max(8, Math.min(H - bh - 8, top));
    el.style.left = left + 'px'; el.style.top = top + 'px';
  }
  // By the Knot: the near corner (set in a little) sits on the tip.
  function placeSlot(el) {
    if (islandOn) {
      // Its own card under the pill, centred on the screen's centre line, the
      // pill's own axis, however wide the pill is at the moment (Pranav, 2026-11-03).
      const b = islandBox(), W = window.innerWidth, bw = el.offsetWidth;
      el.style.left = Math.max(8, Math.round((W - bw) / 2)) + 'px';
      el.style.top = (b.bottom + ISLAND.drop) + 'px';
      return;
    }
    const a = knotAnchor(), inset = KSPEC.inline.surface.anchorInset;
    const W = window.innerWidth, H = window.innerHeight, bw = el.offsetWidth, bh = el.offsetHeight;
    let left = a.dx >= 0 ? a.x - inset : a.x - bw + inset;
    let top = a.dy >= 0 ? a.y : a.y - bh;
    left = Math.max(8, Math.min(W - bw - 8, left));
    top = Math.max(8, Math.min(H - bh - 8, top));
    el.style.left = left + 'px'; el.style.top = top + 'px';
  }
  function placeByKnot(el) {
    if (!isShown(el)) return;
    if (guideTask === 'solve') { layoutAssignmentOverlays(); return; }
    placeSlot(el);
    if (el === quickAsk) clearOfTour(el);
  }
  // The ask line and a tour card are both placed in the Knot's slot, and the card is drawn on top: a
  // card that says "click me and type" covered the very line it asked for (a tester's Mac, 2026-11-15).
  // With a card up, the line sits just above the card, or just below it, and only if neither fits
  // does it go on top of the card.
  function clearOfTour(el) {
    el.classList.remove('over-tour');
    if (!isShown(tourEl)) return;
    const t = tourEl.getBoundingClientRect(), h = el.offsetHeight, H = window.innerHeight, gap = 10;
    const top = t.top - h - gap >= 8 ? t.top - h - gap : t.bottom + gap + h <= H - 8 ? t.bottom + gap : null;
    if (top == null) { el.classList.add('over-tour'); return; }
    el.style.top = Math.round(top) + 'px';
  }
  function positionBubble() {
    if (!isShown(bubble)) return;
    if (bubble.dataset.task === 'solve') {
      layoutAssignmentOverlays();
      return;
    }
    const tip = strand && strand.getTip(), target = strand && strand.getTarget();
    if (bubbleAnchor === 'tip' && target && strand.isLasso && strand.isLasso()) {
      placeBesideLasso(bubble, target);
    } else if (bubbleAnchor === 'tip' && tip && target) {
      // Away from the target, along the thread's approach, so the bubble
      // never covers the control it is talking about.
      const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
      let dx = tip.x - cx, dy = tip.y - cy;
      const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
      placeAt(bubble, tip.x + dx * 16, tip.y + dy * 16, dx, dy);
    } else if (bubbleAnchor === 'tip' && tip) {
      // Perched on a window corner: the bubble sits just inside it.
      const dx = window.innerWidth / 2 > tip.x ? 1 : -1;
      placeAt(bubble, tip.x + dx * 26, tip.y + 30, dx, 1);
    } else {
      placeByKnot(bubble);
    }
    reportBubbleRect();
  }
  // Clear of the lassoed control and of the Knot beside it, whichever side has room.
  function placeBesideLasso(el, target) {
    const W = window.innerWidth, H = window.innerHeight, bw = el.offsetWidth, bh = el.offsetHeight, m = 8, pad = 22;
    const pos = knotPos || { x: 0, y: 0 }, knotR = 64, cx = target.x + target.w / 2, cy = target.y + target.h / 2;
    const away = pos.x <= cx ? 1 : -1;
    const spots = [
      { x: away > 0 ? target.x + target.w + pad : target.x - pad - bw, y: cy - bh / 2 },
      { x: cx - bw / 2, y: target.y + target.h + pad },
      { x: cx - bw / 2, y: target.y - pad - bh },
      { x: away > 0 ? target.x - pad - bw : target.x + target.w + pad, y: cy - bh / 2 },
    ];
    const clearOf = (s, x0, y0, x1, y1) => s.x >= x1 || s.x + bw <= x0 || s.y >= y1 || s.y + bh <= y0;
    const fits = (s) => s.x >= m && s.y >= m && s.x + bw <= W - m && s.y + bh <= H - m && clearOf(s, pos.x - knotR, pos.y - knotR, pos.x + knotR, pos.y + knotR);
    const best = spots.find(fits) || spots[0];
    el.style.left = Math.max(m, Math.min(W - bw - m, best.x)) + 'px';
    el.style.top = Math.max(m, Math.min(H - bh - m, best.y)) + 'px';
  }
  function layoutAssignmentOverlays() {
    const width = Math.min(360, window.innerWidth * 0.3 - 24);
    const orbRect = $('#orb').getBoundingClientRect();
    // The gutter stack sits on the Knot's side of the screen, and stacks away
    // from it: upward from a Knot in the bottom half, downward from the top.
    const onLeft = (orbRect.left + (orbRect.width || 0) / 2) < window.innerWidth / 2;
    const onTop = (orbRect.top + (orbRect.height || 0) / 2) < window.innerHeight / 2;
    const left = onLeft ? 12 : window.innerWidth - width - 12;
    let bottom = Math.min(window.innerHeight - 90, orbRect.top - 14);
    let top0 = Math.max(90, (orbRect.bottom || orbRect.top + 72) + 14);
    // One gutter stack: composer, status, keep chip, then answer above (or below).
    for (const el of [$('#quick-ask'), $('#knot-hint'), keepChip, bubble]) {
      if (!isShown(el)) continue;
      el.style.boxSizing = 'border-box';
      el.style.width = width + 'px'; el.style.maxWidth = width + 'px';
      el.style.maxHeight = Math.max(24, (onTop ? window.innerHeight - top0 : bottom) - 12) + 'px';
      el.style.overflowY = 'auto';
      el.style.left = left + 'px';
      if (onTop) {
        el.style.top = top0 + 'px';
        top0 = top0 + el.offsetHeight + 12;
      } else {
        const top = Math.max(12, bottom - el.offsetHeight);
        el.style.top = top + 'px';
        bottom = top - 12;
      }
    }
    reportBubbleRect();
  }
  let reportedBubbleRect = '';
  function reportBubbleRect() {
    // The laid-out box, not the painted one: while the bubble is still scaling
    // open its painted rect is a sliver, and main masks the screen with this.
    const shown = isShown(bubble);
    const z = zoomFactor();
    const rect = shown ? { x: Math.floor(bubble.offsetLeft * z) - 4, y: Math.floor(bubble.offsetTop * z) - 4, w: Math.ceil(bubble.offsetWidth * z) + 8, h: Math.ceil(bubble.offsetHeight * z) + 8 } : null;
    const key = JSON.stringify(rect);
    if (key !== reportedBubbleRect) { reportedBubbleRect = key; if (nus.assignmentPainted) nus.assignmentPainted({ rect }); }
  }
  // The bubble grows as its words change; keep it placed. (The tip no longer
  // moves while a bubble is open, so nothing needs to track it every frame.)
  if (window.ResizeObserver) new ResizeObserver(() => { if (isShown(bubble)) positionBubble(); }).observe(bubble);

  // Open a surface by the Knot. Speed first: it is there at once and the
  // thread flicks out to its corner alongside. With speed first off it is the
  // playground's exact order: reach, tap, then open. `wait` holds the reveal
  // until whatever was in the slot has finished leaving, so two never overlap;
  // the element is already laid out (and can take focus) while it waits.
  function openSlotSurface(el, place, opts = {}, wait = 0) {
    const solve = guideTask === 'solve';
    const exact = !solve && !islandOn && !KSPEC.host.speedFirst && strand && strand.getState() === 'idle' && !strand.surfaceArrived() && !(knot3d && knot3d.isReduced());
    const opened = () => { if (!solve && strand && strand.surfaceArrived()) strand.burst(slotPoint()); };
    if (solve) { showSurface(el, place, 'hidden', { plain: true }); return; }
    if (!wait && !exact) { showSurface(el, place, 'hidden', opts); opened(); return; }
    showSurface(el, place, 'hidden', { plain: true });
    el.style.opacity = '0';
    const go = () => { if (!isShown(el)) return; el.style.opacity = ''; reveal(el, opts); opened(); };
    if (exact) strand.reachTo(slotPoint(), { onArrive: () => setTimeout(go, Math.round(KSPEC.moves.tap * 1000)) });
    else setTimeout(go, wait);
  }

  // The checklist under a guide step: what was done, this step, what the model
  // expects next. Only a walkthrough with more than one known step shows it.
  function renderSteps(plan) {
    const host = $('#gb-steps');
    if (!host) return;
    host.innerHTML = '';
    const done = (plan && plan.done) || [], next = (plan && plan.next) || [];
    if (!plan || !plan.current || (!done.length && !next.length)) { host.classList.add('hidden'); return; }
    const row = (text, cls) => { const li = document.createElement('li'); li.className = cls; li.textContent = text; host.appendChild(li); };
    done.forEach((t) => row(t, 'done'));
    row(plan.current, 'now');
    next.forEach((t) => row(t, 'next'));
    host.classList.remove('hidden');
  }
  function showBubble(p) {
    bubble.dataset.task = p.task || guideTask || '';
    bubble.dataset.sessionId = p.sessionId == null ? '' : String(p.sessionId);
    bubble.dataset.style = p.style || '';
    bubble.dataset.kind = p.kind || '';
    bubble.dataset.solveGen = p.solveGen == null ? '' : String(p.solveGen);
    $('#gb-kicker').textContent = p.kicker || '';
    $('#gb-text').textContent = p.text || '';
    $('#gb-hint').textContent = p.hint || '';
    renderSteps(p.plan);
    const actions = $('#gb-actions');
    actions.innerHTML = '';
    (p.actions || []).forEach((a) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = a.label || a.id;
      if (a.primary) b.className = 'primary';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        hideBubble();
        if (a.id === 'dismiss' || a.id === 'notnow') dismissGuide(a.id);
        // The introduction's one button: on to the tutorial.
        else if (a.id === 'tour') { clearTimeout(introTimer); dismissGuide('tour'); tourSend('tour-start'); }
        // An error bubble's fix lives in Settings > Keys; open it there.
        else if (a.id === 'settings') { dismissGuide('settings'); if (nus.openSettings) nus.openSettings('keys'); }
        else if (nus.guideAsk) nus.guideAsk({ action: a.id, text: '' });
      });
      actions.appendChild(b);
    });
    bubbleAnchor = p.anchor || 'knot';
    const solve = guideTask === 'solve' || bubble.dataset.task === 'solve';
    errorUp = p.kind === 'error';
    if (errorUp) errorBeat();
    if (solve) {
      // Assignment mode keeps its gutter stack: no projection, no thread.
      showSurface(bubble, positionBubble, 'hidden', { plain: true });
    } else if (p.intro && strand && !(knot3d && knot3d.isReduced())) {
      // Draw the bubble (the introduction only): the thread reaches out, draws
      // the frame by hand, and then the words appear inside it.
      claimKnotSlot(bubble);
      showSurface(bubble, positionBubble, 'hidden', { plain: true });
      bubble.style.opacity = '0'; bubble.style.pointerEvents = 'none';
      const frame = { x: bubble.offsetLeft, y: bubble.offsetTop, w: bubble.offsetWidth, h: bubble.offsetHeight };
      const radius = parseFloat(getComputedStyle(bubble).borderTopLeftRadius) || 12;
      const open = () => { if (!isShown(bubble)) return; bubble.style.opacity = ''; bubble.style.pointerEvents = ''; reveal(bubble, { origin: originAt(bubble, slotPoint), speak: true }); };
      cues.play('intro');
      strand.reachTo(slotPoint(), { onArrive: () => { if (isShown(bubble)) strand.trace(frame, radius, open); } });
    } else if (bubbleAnchor === 'tip') {
      // Tip projection: the frame opens out of the thread's tip, then speaks.
      const tip = strand && strand.getTip();
      showSurface(bubble, positionBubble, 'hidden', { origin: originAt(bubble, tip), speak: true });
      if (tip) strand.burst(tip);
      cues.play('bubble');
    } else {
      // One surface by the Knot at a time: a bubble anchored there replaces the
      // hint, the keep chip and the composer instead of stacking on them.
      const wait = claimKnotSlot(bubble);
      openSlotSurface(bubble, positionBubble, { origin: originAt(bubble, slotPoint), speak: true }, wait);
      cues.play('bubble');
    }
    syncSlot();
    syncKnotUi();
    if (p.speak) say(p.speak);
  }
  function hideBubble() {
    const was = isShown(bubble);
    if (introUp) { introUp = false; clearTimeout(introTimer); }
    const solve = bubble.dataset.task === 'solve';
    hideSurface(bubble, () => { reportBubbleRect(); syncSlot(); }, 'hidden', solve ? { plain: true } : { speak: true });
    reportBubbleRect();
    if (errorUp) { errorUp = false; syncKnotUi(); }
    if (was) syncSlot();
  }
  // What sits on the Knot's own thread: the composer, the hint, or a bubble by the Knot.
  function slotSurfaceShown() { return quickOpen || isShown(knotHint) || isShown($('#tour')) || (isShown(bubble) && bubbleAnchor === 'knot' && bubble.dataset.task !== 'solve'); }
  // The thread by the Knot is out exactly while something needs it there.
  function syncSlotThread() {
    if (!strand) return;
    const solve = guideTask === 'solve';
    const guideOut = strand.getState() !== 'idle';
    const busy = knot3d && knot3d.isTravelling && knot3d.isTravelling();
    // Docked in the pill, cards just drop: the thread is only the hand of
    // Hands and the guide, out while a control is being touched.
    // While it thinks nothing is out: the Knot is the trefoil. The answer's card
    // opens at once and the tail reaches it as the shape turns back.
    const want = !solve && !islandOn && !guideOut && !busy && slotSurfaceShown();
    if (want) { if (!strand.surfaceOut()) strand.reachTo(slotPoint()); }
    else if (strand.surfaceOut()) { strand.releaseSurface(); cues.play('rewind'); }
    // A surface open on the thread holds the strand still once the tip has settled.
    const onThread = guideOut ? (isShown(bubble) && bubbleAnchor === 'tip') : (strand.surfaceOut() && slotSurfaceShown());
    strand.setHeld(!!onThread && !dragging);
  }
  // While anything sits in the Knot's slot the status capsule stays folded:
  // it opens on hover, and the hover is exactly where a bubble lands.
  function syncSlotFold() {
    requestAnimationFrame(() => {
      const open = quickOpen || isShown(keepChip) || isShown(knotHint) || (isShown(bubble) && bubbleAnchor === 'knot' && guideTask !== 'solve');
      $('#toolbar').classList.toggle('slot-open', open);
      syncSlotThread();
    });
  }
  function syncSlot() { syncSlotFold(); }
  // The Knot's slot holds one thing: bubble > composer > keep chip > hint.
  // Whatever arrives claims it and the others leave first, so nothing piles
  // up on the same anchor. Returns how long the leaving takes, so the arrival
  // can wait for it.
  // For the channel's bubble (companion/index.js): nothing by the Knot to take the place of.
  window.__knotSlotFree = () => ![bubble, quickAsk, keepChip].some((el) => isShown(el));
  function claimKnotSlot(el) {
    syncSlotFold();
    let wait = 0;
    for (const other of [bubble, quickAsk, keepChip, knotHint]) {
      if (other === el || !isShown(other)) continue;
      if (other === bubble && bubbleAnchor !== 'knot') continue;
      wait = Math.max(wait, leaveMs(other, other === bubble));
      if (other === quickAsk) { closeQuickAsk(); continue; }
      if (other === keepChip) { clearTimeout(keepTimer); hideSurface(keepChip); continue; }
      if (other === knotHint) { hideHint(); continue; }
      if (other === bubble) hideBubble();
    }
    return wait;
  }

  // ---- the quick ask ---------------------------------------------------
  // Typing is the everyday path: one line by the Knot, Enter sends, Esc
  // closes, the dots open the full sheet for anyone who wants the verbs.
  const quickAsk = $('#quick-ask');
  const quickInput = $('#quick-input');
  // `about` is set when Ctrl+Shift+T opened the composer for the control the
  // thread is pointing at: the line then asks about that control.
  let quickAbout = null;
  const QUICK_PLACEHOLDER = quickInput.placeholder;
  // feedback: the line is a note to Pranav (the tray's Tell Pranav, or the
  // check-in's Tell him); what is typed goes to him, not to the model.
  let quickFeedback = false;
  // contact: the line takes an email address for Pranav's updates list (the
  // contact card's Leave my email). It goes to the main process as that, never as an ask.
  let quickContact = false;
  function openQuickAsk(about, feedback, contact) {
    if (play && play.active) stopPlay('task');
    quickOpen = true;
    const wait = claimKnotSlot(quickAsk);
    quickAbout = about || null;
    quickContact = !!contact && !quickAbout;
    quickFeedback = !!feedback && !quickAbout && !quickContact;
    quickInput.placeholder = quickContact ? 'Your email, then Enter' : quickFeedback ? 'Tell Pranav what to fix or build' : quickAbout ? 'Ask about "' + quickAbout + '"' : QUICK_PLACEHOLDER;
    // Live at once: the line takes the keys from the first frame, whatever the
    // thread is still doing.
    openSlotSurface(quickAsk, () => placeByKnot(quickAsk), { origin: originAt(quickAsk, slotPoint) }, wait);
    cues.play('bubble');
    // The capsule folds while the line is open; the two overlapped (2026-09-15).
    $('#toolbar').classList.add('quick-open');
    syncSlotFold();
    setIgnoreSafe(false);
    quickInput.value = '';
    quickInput.focus();
    syncKnotUi();
    // A brain process starts now, so the ask that follows pays only the model.
    if (nus.guideWarm) nus.guideWarm();
  }
  // A click on the Knot makes this window the foreground one. Once nothing here
  // wants keys the keyboard goes back to the app. A tick later, so that whatever
  // closed the last surface has opened the next one.
  function keysWanted() {
    if (quickOpen || modalOpen() || isShown(tourEl) || (knotMenu && knotMenu.open)) return true;
    const a = document.activeElement;
    return !!(a && a.matches && a.matches('input, textarea, [contenteditable="true"]'));
  }
  let releaseTimer = null;
  function releaseKeys() {
    clearTimeout(releaseTimer);
    releaseTimer = setTimeout(() => { if (document.hasFocus() && !keysWanted() && nus.releaseKeys) nus.releaseKeys(); }, 0);
  }
  function closeQuickAsk() {
    quickOpen = false;
    if (knotMenu && knotMenu.source === 'knot') knotMenu.close();
    quickAbout = null;
    quickFeedback = false;
    quickContact = false;
    quickInput.placeholder = QUICK_PLACEHOLDER;
    hideSurface(quickAsk, syncSlotFold);
    $('#toolbar').classList.remove('quick-open');
    syncSlotFold();
    quickInput.blur();
    setIgnoreSafe(true);
    syncKnotUi();
    releaseKeys();
  }
  quickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closeQuickAsk(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    const text = quickInput.value.trim();
    const about = quickAbout;
    const toPranav = quickFeedback;
    const address = quickContact;
    if (address) { closeQuickAsk(); if (text && nus.guideAsk) nus.guideAsk({ text, source: 'typed', contact: true }); return; }
    if (!text) { closeQuickAsk(); if (!about && !toPranav && !standalone) runMode('guide', ''); return; }
    if (toPranav) { closeQuickAsk(); if (nus.guideAsk) nus.guideAsk({ text, source: 'typed', feedback: true }); return; }
    // The acknowledgement comes first, inside the frame of the keypress; the
    // line closes alongside it.
    ack();
    closeQuickAsk();
    if (nus.guideAsk) nus.guideAsk({ text, source: 'typed', about: !!about });
  });
  // Ctrl+Shift+T (main): the thread is already on the control under the
  // cursor; the composer opens for a question about it.
  nus.on('quick:open', (p) => openQuickAsk(p && p.context ? String(p.context) : null, !!(p && p.feedback), !!(p && p.contact)));
  nus.on('assignment:takeover', () => {
    closeQuickAsk();
    pendingBubble = null;
    afterRewind = null;
    retractOnly = true;
    guideTask = 'solve';
    if (strand && strand.getState() !== 'idle') strand.rewind();
    syncSlot();
  });
  $('#quick-more').addEventListener('click', (e) => { e.stopPropagation(); closeQuickAsk(); showTiles(); });

  // Wind back: Esc, a click on the Knot, a bubble's own dismiss, or main.
  function dismissGuide(reason) {
    clearMarks(false);
    stopSpeaking();
    hideBubble();
    pendingBubble = null;
    retractOnly = false;
    clearTimeout(keepTimer);
    hideSurface(keepChip);
    if (quickOpen) closeQuickAsk();
    if (strand && strand.getState() !== 'idle') { setGuideState('winding'); cues.play('rewind'); strand.rewind(); }
    else endGuide();
    // The bubble's own session rides along, so OK on an old Hands bubble can
    // never stop the task that started after it (live 2026-10-12).
    if (nus.guideDismiss) nus.guideDismiss(reason, bubble.dataset.sessionId || '');
    releaseKeys();
  }

  // The consent chip: Skip is the default and the timeout; Keep is explicit.
  function showKeepChip(sessionId) {
    keepSession = sessionId;
    $('#keep-text').textContent = 'Remember this for next time?';
    $('#keep-yes').classList.remove('hidden');
    $('#keep-no').classList.remove('hidden');
    const wait = claimKnotSlot(keepChip);
    openSlotSurface(keepChip, () => placeByKnot(keepChip), { origin: originAt(keepChip, slotPoint) }, wait);
    syncSlotFold();
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => answerKeep(false, true), 12000);
  }
  function answerKeep(keep, auto) {
    clearTimeout(keepTimer);
    if (!isShown(keepChip)) return;
    if (keep) { if (nus.guideKeep) nus.guideKeep(keepSession); }
    else if (nus.guideSkip) nus.guideSkip(keepSession);
    $('#keep-text').textContent = keep ? 'Remembered. Next time this replays with no model.' : (auto ? 'Forgotten.' : 'Forgotten. Nothing kept.');
    $('#keep-yes').classList.add('hidden');
    $('#keep-no').classList.add('hidden');
    keepTimer = setTimeout(() => hideSurface(keepChip, syncSlotFold), auto ? 500 : 1600);
  }
  $('#keep-yes').addEventListener('click', (e) => { e.stopPropagation(); answerKeep(true, false); });
  $('#keep-no').addEventListener('click', (e) => { e.stopPropagation(); answerKeep(false, false); });

  // The app hint: a few words in a pill by the Knot, on the end of its
  // thread. It goes away on its own; clicking it opens the quick ask.
  const knotHint = $('#knot-hint');
  let hintTimer = null;
  function showHint(p) {
    if (!p || !p.text) return;
    // A tour card is up: the live "You: ..." words and any hint go on the
    // card's status line, never in a box under the sheet (live 2026-11-03).
    if (tourCard && isShown(tourEl)) { trStatus.textContent = String(p.text || ''); if (p.speak) say(p.speak); return; }
    if (islandOn) { islandLine(p.text, Number(p.ms) || 7000); if (p.speak) say(p.speak); return; }
    // The live "You: ..." words while the talk key is held: already showing,
    // so the text is swapped in place, no re-open, the box re-measured.
    if (p.live && isShown(knotHint) && knotHint.dataset.live === '1') {
      knotHint.textContent = p.text;
      placeByKnot(knotHint);
      clearTimeout(hintTimer);
      hintTimer = setTimeout(hideHint, Number(p.ms) || 7000);
      requestAnimationFrame(reportHintRect);
      return;
    }
    knotHint.dataset.live = p.live ? '1' : '';
    knotHint.textContent = p.text;
    knotHint.title = p.hint || '';
    // A hint never displaces what is already by the Knot; it waits its turn.
    if (guideTask !== 'solve' && (quickOpen || isShown(keepChip) || (isShown(bubble) && bubbleAnchor === 'knot'))) return;
    openSlotSurface(knotHint, () => placeByKnot(knotHint), { origin: originAt(knotHint, slotPoint) });
    syncSlotFold();
    if (p.speak) say(p.speak);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, Number(p.ms) || 7000);
    setTimeout(reportHintRect, 60); setTimeout(reportHintRect, 450);
  }
  // The hint's box, for main to mask out of the model's screenshot: it quotes
  // the user's own words, which the model otherwise reads as page text.
  let reportedHintRect = '';
  function reportHintRect() {
    if (islandOn) { reportIslandRect(); return; }
    if (pillFree) { reportIslandRect(); return; }
    const shown = isShown(knotHint);
    const z = zoomFactor();
    const rect = shown ? { x: Math.floor(knotHint.offsetLeft * z) - 4, y: Math.floor(knotHint.offsetTop * z) - 4, w: Math.ceil(knotHint.offsetWidth * z) + 8, h: Math.ceil(knotHint.offsetHeight * z) + 8 } : null;
    const key = JSON.stringify(rect);
    if (key !== reportedHintRect) { reportedHintRect = key; if (nus.assignmentPainted) nus.assignmentPainted({ hint: rect }); }
  }
  nus.on('guide:hint', showHint);
  // A sentence of the current step, spoken as soon as the model wrote it;
  // the first one of a step clears whatever the last step was still saying.
  nus.on('guide:say', (p) => { if (p && p.text) say(p.text, { restart: !!p.first, ack: !!p.ack, cached: !!p.cached, sid: p.sid != null ? String(p.sessionId || '') + ':' + p.sid : null }); });
  nus.on('assignment:voice', p => {
    companionVoiceEnabled = !!(p && p.enabled);
    if (!companionVoiceEnabled) stopSpeaking();
  });
  nus.on('assignment:paint', (p) => {
    if (!p) return;
    // Two frames acknowledge a rendered update, not receipt of the model token.
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const isChip = p.kind === 'new problem' || p.kind === 'seen before';
      const visible = isChip || (isShown(bubble) && bubble.dataset.solveGen === String(p.gen) && (!p.expected || $('#gb-text').textContent.includes(p.expected)) && (p.kind !== 'step' || bubble.dataset.style === 'walkthrough'));
      const at = Date.now(), elapsed = Math.max(0, at - p.changeSeenAt);
      // The chips are for the person, not the benchmark: plain words, no
      // milliseconds. Timing still lands in the solve record through
      // assignmentPainted below, so the numbers are not lost, just not shown.
      if (isChip && visible) {
        showHint({ text: p.kind === 'seen before' ? 'Seen before' : 'New problem', ms: 4000 });
      }
      if (isChip && visible) {
        // The chip was just inserted above; acknowledge only after its paint.
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (nus.assignmentPainted) nus.assignmentPainted({ id: p.id, at: Date.now(), visible: isShown(knotHint) });
        }));
      } else if (nus.assignmentPainted) nus.assignmentPainted({ id: p.id, at, visible });
    }));
  });
  function hideHint() {
    clearTimeout(hintTimer);
    if (!isShown(knotHint)) return;
    hideSurface(knotHint, () => { syncSlotFold(); reportHintRect(); });
    syncSlotFold();
    reportHintRect();
  }
  knotHint.addEventListener('click', (e) => { e.stopPropagation(); hideHint(); openQuickAsk(); });

  // ---- island mode ---------------------------------------------------------
  // A black pill 8 px below the top edge, centred, growing both ways. The
  // state word sits at the left with one small accent per state; the Knot
  // rides the right end, so it slides out as the words come in. Idle is the
  // Knot alone, 48 by 40. The open and the close take Clicky's measured
  // timing (knot-spec.js character.island). One line (your words, then the
  // first sentence of the answer) sits under the word. Cards (the Hands
  // ask-first card, answers, the quick ask) drop below it as their own card.
  // The pill never takes the mouse; the Knot in it does.
  const ISLAND = KSPEC.character.island;
  const islandEl = document.createElement('div');
  islandEl.id = 'island';
  islandEl.setAttribute('role', 'status');
  islandEl.setAttribute('aria-live', 'polite');
  islandEl.innerHTML = '<span class="isl-text"><span class="isl-row"><i class="isl-dot" aria-hidden="true"></i><b class="isl-word"></b></span><span class="isl-step"></span><span class="isl-line"></span></span><span class="isl-count"></span><span class="isl-esc" aria-hidden="true"><kbd>Esc</kbd>to stop</span><span class="isl-bar" aria-hidden="true"><i></i></span><span class="isl-slot"></span>';
  islandEl.style.width = ISLAND.idle + 'px';
  document.body.insertBefore(islandEl, document.body.firstChild);
  const islWord = islandEl.querySelector('.isl-word'), islLine = islandEl.querySelector('.isl-line');
  const islStep = islandEl.querySelector('.isl-step'), islBar = islandEl.querySelector('.isl-bar i'), islCount = islandEl.querySelector('.isl-count');
  let islLineTimer = null;
  // The width the pill is committed at (it always rides an explicit width), and
  // the move it is making, if any.
  let islWidth = ISLAND.idle, islAnim = null, islTimeScale = 1;   // timeScale > 1 only for captures
  function islandBox() {
    const r = islandEl.getBoundingClientRect();
    if (r.width) return r;
    const left = Math.round(window.innerWidth / 2 - islWidth / 2);
    return { left, top: ISLAND.top, width: islWidth, height: ISLAND.h, right: left + islWidth, bottom: ISLAND.top + ISLAND.h };
  }
  // The Knot's centre for a pill this wide: inside its right end.
  function islandKnotX(width) { return Math.round(window.innerWidth / 2 + width / 2) - ISLAND.pad - ISLAND.h / 2; }
  function dockKnot(opts = {}) {
    applyKnotPos({ x: islandKnotX(islWidth), y: ISLAND.top + ISLAND.h / 2 }, { dock: true, silent: !!opts.silent });
  }
  // What the pill would be with its words laid out, idle at the least.
  function islandNaturalWidth() {
    islandEl.style.width = 'auto';
    const w = Math.max(ISLAND.idle, Math.ceil(islandEl.getBoundingClientRect().width));
    islandEl.style.width = (islAnim ? islAnim.now : islWidth) + 'px';
    return w;
  }
  // Clicky's measured motion. Open: one frame to 7 percent past the target,
  // back by 70 ms. Close: to 77 percent of idle at 150 ms, a bounce to 140
  // percent at 250, settled by 480. null = the move is over.
  function islandWidthAt(a, u) {
    const O = ISLAND.open, C = ISLAND.close, lerp = (x, y, k) => x + (y - x) * k, out = (k) => 1 - (1 - k) * (1 - k), inout = KSPEC.smooth;
    const still = knot3d && knot3d.isReduced && knot3d.isReduced();
    if (a.kind === 'close') {
      if (still) return u < C.at[0] ? lerp(a.from, a.to, inout(u / C.at[0])) : null;
      const low = a.to * C.low, high = a.to * C.high;
      if (u < C.at[0]) return lerp(a.from, low, inout(u / C.at[0]));
      if (u < C.at[1]) return lerp(low, high, out((u - C.at[0]) / (C.at[1] - C.at[0])));
      if (u < C.at[2]) return lerp(high, a.to, inout((u - C.at[1]) / (C.at[2] - C.at[1])));
      return null;
    }
    if (!still && a.to > a.from) {
      if (u < O.snap) return lerp(a.from, a.to * O.over, u / O.snap);
      if (u < O.settle) return lerp(a.to * O.over, a.to, out((u - O.snap) / (O.settle - O.snap)));
      return null;
    }
    return u < O.settle ? lerp(a.from, a.to, out(u / O.settle)) : null;
  }
  // The pill moves to a new width and the Knot rides its right end: the orb
  // takes a transform while it moves, like a flight, and the layout is
  // committed once at the end. A new width mid-move carries on from where it is.
  function islandGrowTo(to) {
    const from = islAnim ? islAnim.now : islWidth;
    if (to === from && !islAnim) { islandSettled(); return; }
    // The same width asked for again mid-move (a line clearing as the word
    // goes) never restarts the clock: the move it is on already ends there.
    if (islAnim && islAnim.to === to) return;
    const running = !!islAnim;
    islAnim = { from, to, now: from, kind: to <= ISLAND.idle && from > ISLAND.idle ? 'close' : 'move', start: performance.now() / 1000 };
    if (running) return;
    const base = islandKnotX(islWidth);
    if (islandOn) appEl.classList.add('skating');
    const step = () => {
      const a = islAnim;
      if (!a) return;
      const w = islandWidthAt(a, (performance.now() / 1000 - a.start) / islTimeScale);
      if (w == null) {
        islAnim = null; islWidth = a.to;
        islandEl.style.width = a.to + 'px';
        if (islandOn) {
          orbEl.style.transform = '';
          dockKnot();
          requestAnimationFrame(() => appEl.classList.remove('skating'));
        }
        islandSettled();
        return;
      }
      a.now = w;
      islandEl.style.width = w + 'px';
      if (islandOn) orbEl.style.transform = 'translate(' + (islandKnotX(w) - base).toFixed(2) + 'px,0)';
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
  function islandSettled() {
    requestAnimationFrame(() => { reportIslandRect(); if (pillFree && !pillWanted()) hideFreePill(); if (isShown(bubble) || quickOpen || isShown(keepChip)) followKnot(); if (knotMenu) knotMenu.relayout(); });
  }
  // The words, in the order they outrank each other: the key held, Hands at
  // work (its spoken line rides under the word), the voice, a guide step, thought.
  const ISLAND_WORDS = { listening: 'Listening, release to send', transcribing: 'Thinking', reading: 'Reading', thinking: 'Thinking', keeping: 'Keeping', unwinding: 'Pointing', pointing: 'Pointing', nudging: 'Note', explaining: 'Answering', done: 'Done' };
  const ISLAND_TONES = { listening: 'listening', transcribing: 'thinking', reading: 'reading', thinking: 'thinking', keeping: 'thinking', unwinding: 'thinking', pointing: 'thinking', nudging: 'thinking', explaining: 'thinking', done: 'thinking' };
  let handsState = { active: false, waiting: false };
  let lastIslandState = 'idle';
  function syncIsland(state) {
    if (!pillReady) return;
    lastIslandState = state;
    let word = '', tone = 'idle';
    if (pttHeld || guideState === 'listening' || state === 'listening') { word = ISLAND_WORDS.listening; tone = 'listening'; }
    else if (handsState.active) { word = handsState.waiting ? 'Hands is waiting for you' : 'Hands is working'; tone = 'hands'; }
    else if (speakingNow) { word = 'Speaking'; tone = 'speaking'; }
    else if (guideState && ISLAND_WORDS[guideState]) { word = ISLAND_WORDS[guideState]; tone = ISLAND_TONES[guideState]; }
    else if (state === 'thinking') { word = 'Thinking'; tone = 'thinking'; }
    const v = pill.dress({ word, tone, hands: handsState, tasks: taskPanel ? taskPanel.tasks : [], flash: pillFlash, now: Date.now() });
    islWord.textContent = v.word;
    islandEl.dataset.state = v.tone;
    // The spec's accent when it names one; otherwise the rules in styles.css.
    const accent = pill.accentFor(KSPEC, v.tone);
    if (accent) islandEl.style.setProperty('--isl-acc', accent); else islandEl.style.removeProperty('--isl-acc');
    islandEl.classList.toggle('hands-live', handsState.active && !handsState.waiting);
    pillStep.set(v.step);
    islandEl.classList.toggle('has-bar', v.bar != null);
    if (v.bar != null) islBar.style.width = Math.round(v.bar * 100) + '%';
    islCount.textContent = v.count;
    islandEl.classList.toggle('has-count', !!v.count);
    // Holds the pill at its widest while a task runs, so a shorter step never makes it jump.
    pillHeldOpen = !!(v.step || v.esc);
    relayoutIsland();
    reportKnotWord(v);
  }
  // The dashboard's copy of the pill: the same words and the accent the pill
  // really wears, so the dashboard never names a colour of its own.
  let reportedKnotWord = '';
  function reportKnotWord(v) {
    if (!nus.guideAsk) return;
    const payload = { action: 'knot-word', word: v.word, tone: v.tone, step: v.step, bar: v.bar, esc: v.esc, accent: getComputedStyle(islandEl).getPropertyValue('--isl-acc').trim() };
    const key = JSON.stringify(payload);
    if (key !== reportedKnotWord) { reportedKnotWord = key; nus.guideAsk(payload); }
  }
  // Main says when Hands has the mouse and when it is waiting on a card.
  // Hands start sounds as it takes the mouse, Hands stop as it gives it back
  // (right before the spoken "Done"); a run over 20 s also gets the two done
  // notes a moment later, for a person who looked away. Never over speech:
  // the gate still holds for these.
  let handsSince = 0;
  function setHandsState(active, waiting) {
    const was = handsState.active;
    handsState = { active: !!active, waiting: !!waiting };
    if (handsState.active && !was) { handsSince = Date.now(); cues.play('hands-start'); }
    if (!handsState.active && was) {
      cues.play('hands-stop');
      if (Date.now() - handsSince > KSPEC.character.cues.longRunMs) setTimeout(() => cues.play('done-notes'), 450);
    }
    syncHandsGlow(); syncKnotUi();
  }
  nus.on('hands:state', (p) => setHandsState(p && p.active, p && p.waiting));
  function islandLine(text, ms) {
    islLine.textContent = String(text || '');
    clearTimeout(islLineTimer);
    islLineTimer = setTimeout(() => { islLine.textContent = ''; relayoutIsland(); }, ms || 7000);
    noteActivity();
    relayoutIsland();
  }
  function relayoutIsland() {
    const text = !!(islWord.textContent || islLine.textContent);
    islandEl.classList.toggle('has-text', text);
    islandEl.classList.toggle('has-line', !!islLine.textContent);
    islandEl.classList.toggle('can-unfold', !!(taskPanel && taskPanel.available()));
    islandEl.classList.toggle('live', text || !!islCount.textContent || !!(taskPanel && taskPanel.open));
    syncFreePill();
    if (islandOn || pillFree) islandGrowTo(taskPanel && taskPanel.open ? ISLAND.panel : heldWidth(islandNaturalWidth()));
  }
  // ---- the pill during a task (pill.js) ------------------------------------
  const pill = window.NusPill;
  let pillFlash = null, pillFlashTimer = null, pillHeldOpen = false, pillHold = 0;
  const pillStep = pill.stepper({ apply: (text) => {
    islStep.textContent = text;
    islandEl.classList.toggle('has-step', !!text);
    relayoutIsland();
  } });
  function heldWidth(w) {
    if (!pillHeldOpen) { pillHold = 0; return w; }
    pillHold = Math.max(pillHold, w);
    return pillHold;
  }
  // A task's end: a moment of Done or Did not work on the pill, then back.
  function pillOnTask(p) {
    const flash = pill.flashFor(p, Date.now());
    if (flash) {
      pillFlash = flash;
      clearTimeout(pillFlashTimer);
      pillFlashTimer = setTimeout(() => { pillFlash = null; syncIsland(lastIslandState); }, pill.FLASH_MS);
    } else if (p && p.type === 'started') { pillFlash = null; clearTimeout(pillFlashTimer); }
    syncIsland(lastIslandState);
  }
  // The free Knot's pill: up for a task, list or Done, gone after it (O6 B).
  function pillWanted() { return pill.wanted({ island: false, hands: handsState, tasks: taskPanel ? taskPanel.tasks : [], flash: pillFlash, panelOpen: !!(taskPanel && taskPanel.open), now: Date.now() }); }
  function syncFreePill() {
    if (islandOn) return;
    if (!pillFree && pillWanted()) { pillFree = true; document.body.classList.add('pill-free'); }
  }
  function hideFreePill() {
    pillFree = false;
    document.body.classList.remove('pill-free');
    islAnim = null; islWidth = ISLAND.idle; islandEl.style.width = ISLAND.idle + 'px';
    reportedIslandRect = ''; if (nus.assignmentPainted) nus.assignmentPainted({ hint: null });
    if (knotMenu && knotMenu.source === 'pill') knotMenu.close();
  }
  // The task list: this pill, unfolded (task-panel.js). The same element, the
  // same words and the same timing; the Knot rides the right end as ever.
  const taskPanel = window.NusTaskPanel ? window.NusTaskPanel.create({
    doc: document,
    host: islandEl,
    // Esc stays armed while either the list or the menu is up.
    send: (p) => nus.guideAsk(p && p.action === 'task-panel' ? { action: 'task-panel', open: !!p.open || !!(knotMenu && knotMenu.open) } : p),
    onLayout: () => { relayoutIsland(); requestAnimationFrame(reportIslandRect); },
  }) : null;
  // The free Knot's hover panel: the same panel again, in a host of its own beside
  // the Knot (HOVER_OPEN_MS on the Knot, or one tap on a touchscreen). It reads the
  // same events, and like the pill it is masked out of what the model reads.
  const knotPanelEl = document.createElement('div');
  knotPanelEl.id = 'knot-panel';
  document.body.appendChild(knotPanelEl);
  const knotPanel = window.NusTaskPanel ? window.NusTaskPanel.create({
    doc: document,
    host: knotPanelEl,
    emptyOk: true,
    send: (p) => nus.guideAsk(p),
    onLayout: () => placeKnotPanel(),
  }) : null;
  function placeKnotPanel() {
    let rect = null;
    if (knotPanel && knotPanel.open) {
      const p = window.NusTaskPanel.besideKnot($('#orb').getBoundingClientRect(), { w: knotPanelEl.offsetWidth, h: knotPanelEl.offsetHeight }, { w: window.innerWidth, h: window.innerHeight });
      knotPanelEl.style.left = p.left + 'px'; knotPanelEl.style.top = p.top + 'px'; knotPanelEl.dataset.side = p.side;
      const z = zoomFactor(), r = knotPanelEl.getBoundingClientRect();
      rect = { x: Math.floor(p.left * z) - 4, y: Math.floor(p.top * z) - 4, w: Math.ceil(r.width * z) + 8, h: Math.ceil(r.height * z) + 8 };
    }
    if (nus.assignmentPainted) nus.assignmentPainted({ panel: rect });
  }
  // Something else by the Knot: a hover stays a hover. Nothing listed still opens,
  // with the empty state.
  function knotPanelMayOpen() {
    return !islandOn && knotPanel.available() && !(taskPanel && taskPanel.open) && !quickOpen && !(knotMenu && knotMenu.open) && !isShown(bubble) && !isShown(tourEl) && !modalOpen() && !dragging && !fileDragActive && !pttHeld;
  }
  const knotHover = knotPanel && window.NusTaskPanel.presence({
    dwellMs: window.NusTaskPanel.HOVER_OPEN_MS,
    leaveMs: window.NusTaskPanel.HOVER_LEAVE_MS,
    isOpen: () => knotPanel.open,
    canOpen: knotPanelMayOpen,
    open: () => knotPanel.setOpen(true),
    close: () => knotPanel.setOpen(false),
    holds: () => knotPanel.typing(),
  });
  function knotPanelShut() { clearTimeout(knotTapTimer); knotPanel.setOpen(false); knotHover.shut(); }
  function knotPanelBack() {
    if (!knotPanel.open) return false;
    knotPanel.back();
    if (!knotPanel.open) knotPanelShut();
    return true;
  }
  // Opened by a tap there may be no pointer to leave: it goes by itself unless touched again.
  let knotTapTimer = null;
  function knotTapFold() { clearTimeout(knotTapTimer); knotTapTimer = setTimeout(() => { if (knotPanel.typing()) knotTapFold(); else knotPanelShut(); }, window.NusTaskPanel.FOLD_AFTER_MS); }
  function knotPanelTap() {
    if (knotPanel.open) { knotPanelShut(); return; }
    knotPanel.setOpen(true);
    knotTapFold();
  }
  knotPanelEl.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') knotTapFold(); });
  nus.on('tasks:event', (p) => {
    if (!taskPanel) return;
    if (p && p.type === 'esc' && knotMenu && knotMenu.open) { knotMenu.close(); return; }
    if (p && p.type === 'esc' && knotPanel && knotPanelBack()) return;
    if (knotPanel) knotPanel.onEvent(p);
    taskPanel.onEvent(p);
    pillOnTask(p);
    // Answered in the list or by voice: the Knot's copy of the card goes too.
    if (p && p.type === 'answered' && isShown(bubble) && bubble.dataset.task === 'hands') hideBubble();
  });
  if (nus.settingsGet) nus.settingsGet().then((s) => { if (taskPanel && s && s._ptt) taskPanel.setKey(s._ptt); if (knotPanel && s && s._ptt) knotPanel.setKey(s._ptt); }).catch(() => {});
  // An open list folds once the pointer has left it. The Knot riding the pill counts as with it.
  const listPresence = taskPanel && window.NusTaskPanel.presence({
    leaveMs: window.NusTaskPanel.FOLD_AFTER_MS,
    isOpen: () => taskPanel.open,
    close: () => taskPanel.setOpen(false),
    holds: () => taskPanel.typing() || taskPanel.waiting(),
  });
  function pointerTick(x, y, handsMoving) {
    const el = x < 0 ? null : document.elementFromPoint(x, y);
    if (listPresence) listPresence.pointer(!!(el && el.closest && el.closest('#island, #orb, #knot-menu')));
    if (!knotHover) return;
    // Hands' own mouse crossing the Knot is not the person hovering it.
    knotHover.pointer(!islandOn && !handsMoving && !!(el && el.closest && el.closest('#orb, #knot-panel')));
    // Something else came to the Knot, or the Knot is on the move: the list gives way.
    if (knotPanel.open && (islandOn || dragging || quickOpen || isShown(bubble))) knotPanelShut();
  }
  // Read and drive handle for the CDP checks and captures, like __nusIsland.
  window.__nusTasks = taskPanel;
  window.__nusKnotPanel = knotPanel;
  if (taskPanel) taskPanel.showWindows = showProjectWindows;
  let reportedIslandRect = '';
  function reportIslandRect() {
    // The pill quotes your own words and the answer: mask it out of every
    // screenshot the model reads, the way the hint is masked.
    const z = zoomFactor(), r = islandEl.getBoundingClientRect();
    const rect = (islandOn || pillFree) && r.width ? { x: Math.floor(r.left * z) - 4, y: Math.floor(r.top * z) - 4, w: Math.ceil(r.width * z) + 8, h: Math.ceil(r.height * z) + 8 } : null;
    const key = JSON.stringify(rect);
    if (key !== reportedIslandRect) { reportedIslandRect = key; if (nus.assignmentPainted) nus.assignmentPainted({ hint: rect }); }
  }
  function setIsland(on) {
    on = !!on;
    if (on === islandOn) return;
    const menuStays = !!(knotMenu && knotMenu.open);
    if (quickOpen) closeQuickAsk();
    if (!on && taskPanel) taskPanel.setOpen(false);
    if (on && knotPanel && knotPanel.open) knotPanelShut();
    islandOn = on;
    document.body.classList.toggle('island', on);
    if (pillFree) { pillFree = false; document.body.classList.remove('pill-free'); }
    if (on) { hideHint(); dockKnot(); }
    else {
      islLine.textContent = ''; islWord.textContent = '';
      islAnim = null; islWidth = ISLAND.idle; islandEl.style.width = ISLAND.idle + 'px'; orbEl.style.transform = '';
      appEl.style.translate = '';
      reportedIslandRect = ''; if (nus.assignmentPainted) nus.assignmentPainted({ hint: null });
      // Main sends the saved spot right after (knot:pos); until then, the corner.
      applyCorner('br', false);
    }
    applyKnotSize(lastKnotSize, false);
    syncKnotUi();
    requestAnimationFrame(followKnot);
    if (menuStays) knotMenu.show(on ? 'pill' : 'knot');
  }
  nus.on('knot:island', (p) => { const on = !!(p && p.on); if ((on !== islandOn || tourIslandWant !== null) && tourCard && isShown(tourEl) && knot3d && !reducedMotion()) tourIslandSwitch(on); else setIsland(on); });
  // ---- the options menu (knot-menu.js, quick-options.js) ---------------------
  // Hung from the pill it sits on the centre line, under whatever the pill has
  // already handed down. By the free Knot it stacks on the ask line.
  function placeMenu(el, source) {
    const W = window.innerWidth, H = window.innerHeight, mw = el.offsetWidth, mh = el.offsetHeight;
    const clampX = (x) => Math.max(8, Math.min(W - mw - 8, x)), clampY = (y) => Math.max(8, Math.min(H - mh - 8, y));
    const edges = (n) => { const left = parseFloat(n.style.left) || 0, top = parseFloat(n.style.top) || 0; return { left, top, right: left + n.offsetWidth, bottom: top + n.offsetHeight }; };
    const under = isShown(bubble) ? bubble : quickOpen ? quickAsk : null;
    if (source === 'pill' && (islandOn || pillFree)) {
      const b = islandBox();
      el.style.left = clampX(Math.round((W - mw) / 2)) + 'px';
      el.style.top = clampY(islandOn && under ? edges(under).bottom + 8 : b.bottom + ISLAND.drop) + 'px';
      return;
    }
    const a = knotAnchor(), inset = KSPEC.inline.surface.anchorInset, e = quickOpen ? edges(quickAsk) : null;
    const x = a.dx >= 0 ? (e ? e.left : a.x - inset) : (e ? e.right : a.x + inset) - mw;
    const y = a.dy >= 0 ? (e ? e.bottom + 8 : a.y) : (e ? e.top - 8 : a.y) - mh;
    el.style.left = clampX(x) + 'px';
    el.style.top = clampY(y) + 'px';
  }
  const knotMenu = window.NusKnotMenu ? window.NusKnotMenu.create({
    doc: document,
    options: window.NusQuickOptions,
    read: () => (nus.settingsGet ? nus.settingsGet() : null),
    write: (patch) => nus.settingsSet(patch),
    action: (id) => { if (id === 'play') { startPlay(); return; } nus.guideAsk({ action: id }); },
    // Reduce motion on: the row stays, and picking it says why there is no game.
    canPlay: () => { const why = playBlocker(); return why === '' || why === 'reduced-motion'; },
    place: placeMenu,
    onChange: (open) => {
      nus.guideAsk({ action: 'task-panel', menu: true, open: open || !!(taskPanel && taskPanel.open) });
      // While Hands works, the keyboard stays with the window in front.
      // With the ask line open the keys stay on it: the menu taking them left what
      // was typed going nowhere after a click on the free Knot.
      if (open) { if (!handsState.active && !quickOpen) knotMenu.el.focus({ preventScroll: true }); requestAnimationFrame(() => knotMenu.relayout()); setTimeout(() => knotMenu.relayout(), 350); }
      else if (knotMenu.source === 'knot') releaseKeys();
    },
  }) : null;
  if (knotMenu) document.body.appendChild(knotMenu.el);
  nus.on('settings:changed', (s) => { if (knotMenu) knotMenu.setSettings(s); });
  window.addEventListener('blur', () => { if (knotMenu) knotMenu.close(); });
  // On the pill: a click on the state word unfolds the list; a right click or a
  // long press opens the menu. The same on the Knot riding it.
  const LONG_PRESS_MS = 500;
  let pressTimer = null, pressAt = null, pressedLong = false;
  // A finger held down opens the menu on the timer, and Chromium then sends the
  // contextmenu of a long press as well: toggling on that shut it again at once.
  function menuFromPill(e) { e.preventDefault(); e.stopPropagation(); if (knotMenu && !pressedLong) knotMenu.toggle('pill'); }
  function pressStart(e) {
    pressedLong = false;
    if (e.button !== 0) return;
    pressAt = { x: e.clientX, y: e.clientY };
    clearTimeout(pressTimer);
    pressTimer = setTimeout(() => { pressedLong = true; suppressClick = true; setTimeout(() => { suppressClick = false; }, 600); if (knotMenu) knotMenu.show('pill'); }, LONG_PRESS_MS);
  }
  function pressMove(e) { if (pressAt && Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) > 6) { clearTimeout(pressTimer); pressAt = null; } }
  function pressEnd() { clearTimeout(pressTimer); pressAt = null; }
  islandEl.addEventListener('contextmenu', menuFromPill);
  islandEl.addEventListener('pointerdown', (e) => { if (!e.target.closest('.tp')) pressStart(e); });
  islandEl.addEventListener('pointermove', pressMove);
  islandEl.addEventListener('pointerup', pressEnd);
  islandEl.addEventListener('pointercancel', pressEnd);
  islandEl.addEventListener('pointerleave', pressEnd);
  islandEl.querySelector('.isl-text').addEventListener('click', () => {
    if (pressedLong) { pressedLong = false; return; }
    if (taskPanel && taskPanel.available()) taskPanel.toggle();
  });
  // A double click always leaves it open, where two clicks alone would shut it again.
  islandEl.querySelector('.isl-text').addEventListener('dblclick', () => { if (taskPanel && taskPanel.available()) taskPanel.setOpen(true); });
  // The Knot: a right click opens the menu wherever it lives; in the pill a long press does too.
  orbEl.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); if (knotMenu && !(islandOn && pressedLong)) knotMenu.toggle(islandOn ? 'pill' : 'knot'); });
  orbEl.addEventListener('pointerdown', (e) => { if (islandOn) pressStart(e); });
  orbEl.addEventListener('pointermove', (e) => { if (islandOn) pressMove(e); });
  orbEl.addEventListener('pointerup', () => pressEnd());
  orbEl.addEventListener('pointercancel', () => pressEnd());
  window.__nusMenu = knotMenu;
  window.__nusPill = { get free() { return pillFree; }, get flash() { return pillFlash; }, get step() { return pillStep.shown; } };
  pillReady = true;
  syncIsland(lastIslandState);
  window.addEventListener('resize', () => { if (islandOn) requestAnimationFrame(() => dockKnot()); });
  // Read and drive handles for the CDP checks and captures, like __nusMotion.
  window.__nusHands = { set: setHandsState, get state() { return handsState; } };
  window.__nusIsland = { set: setIsland, line: islandLine, get on() { return islandOn; }, get width() { return islWidth; }, speaking(on) { setSpeaking(!!on); }, slow(k) { islTimeScale = Math.max(1, Number(k) || 1); } };

  // ---- the Hands edge glow -------------------------------------------------
  // One cool blue glow round the whole screen edge while Hands has the mouse
  // (renders-0115, O3 A): the one clear sign that it is in control. Four edge
  // strips, each painted once; only their opacity moves, set from here a few
  // times a second. A full screen layer on a CSS animation cost 19 percent of
  // a core on the 4700U (design/renders-0115-2026-11-02/after/2-glow); the
  // strips at 12 updates a second are what the budget allows. Half strength
  // while a consent card waits, because then the mouse is yours. Gone the
  // instant Hands stops: the strips hide and nothing fades.
  const GLOW = KSPEC.character.glow;
  const glowEl = document.createElement('div');
  glowEl.id = 'hands-glow';
  glowEl.setAttribute('aria-hidden', 'true');
  glowEl.innerHTML = '<i class="top"></i><i class="right"></i><i class="bottom"></i><i class="left"></i>';
  document.body.insertBefore(glowEl, document.body.firstChild);
  const glowStrips = Array.from(glowEl.children);
  let glowTimer = null, glowStart = 0;
  function glowLevel(now) {
    const still = knot3d && knot3d.isReduced && knot3d.isReduced();
    const k = handsState.waiting ? GLOW.half : 1;
    if (still) return k * (GLOW.low + GLOW.high) / 2;
    const u = ((now - glowStart) / 1000) % GLOW.period / GLOW.period;
    return k * (GLOW.low + (GLOW.high - GLOW.low) * (.5 - .5 * Math.cos(u * 2 * Math.PI)));
  }
  function glowTick() {
    const v = glowLevel(performance.now()).toFixed(3);
    for (const el of glowStrips) el.style.opacity = v;
  }
  function syncHandsGlow() {
    const on = handsState.active;
    document.body.classList.toggle('hands-driving', on);
    document.body.classList.toggle('hands-waiting', on && handsState.waiting);
    if (on && !glowTimer) { glowStart = performance.now(); glowTimer = setInterval(glowTick, 1000 / GLOW.fps); }
    if (on) glowTick();
    if (!on && glowTimer) { clearInterval(glowTimer); glowTimer = null; for (const el of glowStrips) el.style.opacity = '0'; }
  }

  nus.on('guide:state', (p) => setGuideState(p && p.state, p && p.task));
  // A whole window or a big panel: a point in its middle says nothing, so the
  // thread perches on its corner instead (Little acrobat). Sparingly.
  function perchWorthy(rect, frame) {
    const A = KSPEC.host.acrobat;
    return !!frame && rect.w >= A.minWidth && rect.h >= A.minHeight;
  }
  let stepsThisGuide = 0;
  nus.on('guide:target', (p) => { stopWindowTour(false); onGuideTarget(p); });
  // A project resuming: the Knot's one thread goes to each open window that is
  // the project's, one after another, and comes home. Hands' first target takes
  // the thread over. Held still under reduced motion: the first window only.
  const WINDOW_TOUR = KSPEC.host.projectWindows;
  let windowTour = null;
  function stopWindowTour(rewind) {
    if (!windowTour) return;
    clearTimeout(windowTour.timer);
    windowTour = null;
    // Only the thread goes home: the project's answer stays up to be read (it went
    // with the rewind, 3 s after "what were we working on").
    if (rewind && strand && strand.getState() !== 'idle') { retractOnly = true; cues.play('rewind'); strand.rewind(); }
  }
  function showProjectWindows(rects) {
    stopWindowTour(false);
    if (!strand || !rects.length || guideActive()) return;
    const list = knot3d && knot3d.isReduced && knot3d.isReduced() ? rects.slice(0, 1) : rects;
    let i = 0;
    const next = () => {
      if (!windowTour) return;
      if (i >= list.length) { stopWindowTour(true); return; }
      strand.setTarget(dipRectToCss(list[i++]), { task: 'hands' });
      windowTour.timer = setTimeout(next, WINDOW_TOUR.holdMs);
    };
    windowTour = { timer: null };
    cues.play('reach');
    next();
  }
  nus.on('tasks:windows', (p) => { if (p && Array.isArray(p.rects)) showProjectWindows(p.rects.filter((r) => r && r.w > 0 && r.h > 0)); });
  // "Circle it": a ring drawn around the control the thread points at, for a
  // few seconds. Pointer-free; a new step or the end of the guide removes it.
  function clearCircle() { clearTimeout(circleTimer); circleTimer = null; if (circleEl) { circleEl.remove(); circleEl = null; } }
  function drawCircle() {
    if (strand && strand.replayLasso && strand.replayLasso()) return true;
    const r = lastTargetRect || (strand && strand.getTarget && strand.getTarget());
    if (!r || !(r.w > 0) || !(r.h > 0)) return false;
    clearCircle();
    const pad = 12, w = Math.round(r.w + pad * 2), h = Math.round(Math.max(r.h + pad * 2, 36));
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'guide-circle');
    svg.setAttribute('width', String(w + 8)); svg.setAttribute('height', String(h + 8));
    svg.style.left = Math.round(r.x - pad - 4) + 'px';
    svg.style.top = Math.round(r.y + r.h / 2 - h / 2 - 4) + 'px';
    const e = document.createElementNS(NS, 'ellipse');
    e.setAttribute('cx', String(w / 2 + 4)); e.setAttribute('cy', String(h / 2 + 4));
    e.setAttribute('rx', String(w / 2)); e.setAttribute('ry', String(h / 2));
    e.setAttribute('pathLength', '100');
    svg.appendChild(e);
    document.body.appendChild(svg);
    circleEl = svg;
    circleTimer = setTimeout(clearCircle, 6000);
    return true;
  }
  nus.on('guide:circle', () => { if (!drawCircle()) showHint({ text: 'Ask me where something is first, then say "circle it".', ms: 3500 }); });
  function onGuideTarget(p) {
    if (!strand || !p || !p.bbox) return;
    hideBubble();
    clearTimeout(keepTimer);
    hideSurface(keepChip);
    const task = p.task || 'guide';
    targetSeq = p.seq != null ? p.seq : null;
    retractOnly = false;
    const wasOut = strand.getState() !== 'idle';
    setGuideState('unwinding', task);
    // Hands just does it: the thread shows what it touches, with no card
    // naming it ("HANDS / Firefox" sat on the Knot, live 2026-10-22), and a
    // whole window coming up gets no thread at all.
    const silent = task === 'hands' || !!p.quiet;
    const rectNow = dipRectToCss(p.bbox);
    if (silent && rectNow.w >= window.innerWidth * 0.5 && rectNow.h >= window.innerHeight * 0.5) { pendingBubble = null; return; }
    pendingBubble = silent ? null : {
      kicker: p.kicker != null ? p.kicker : (p.step ? 'step ' + p.step + ' of ' + (p.stepCount || '?') : ''),
      text: p.instruction || p.label || '',
      hint: p.hint || '',
      actions: p.actions || [],
      task,
      anchor: 'tip',
      speak: p.speak,
    };
    const rect = dipRectToCss(p.bbox), frame = p.window ? dipRectToCss(p.window) : null;
    // The area the sentence names, when main found one: drawn round first,
    // then the lasso on the control (renders-0115, O4 option C).
    const region = p.region && Number.isFinite(p.region.w) && p.region.w > 0 ? dipRectToCss(p.region) : null;
    clearCircle(); lastTargetRect = rect;
    // A walkthrough: it goes there itself and lassos the control. Hands, the pill
    // and whole windows keep the thread.
    if (!silent && !islandOn && !dragging && knotPos && knot3d && !perchWorthy(rect, frame)) {
      stepsThisGuide = wasOut ? stepsThisGuide + 1 : 1;
      if (!skateHome) skateHome = { x: knotPos.x, y: knotPos.y };
      moveKnotTo(spotBeside(rect), { persist: false, keepGuide: true, lasso: rect, region });
      return;
    }
    const point = () => {
      // Inside one walkthrough the reach motif can be kept to the first step.
      stepsThisGuide = wasOut ? stepsThisGuide + 1 : 1;
      if (!(KSPEC.host.quietWalkthrough && stepsThisGuide > 1)) cues.play('reach');
      if (perchWorthy(rect, frame)) { if (strand.perch(rect, frame, { task })) return; }
      strand.setTarget(rect, { task });
    };
    // Sitting on what it has to point at: step aside first, then point.
    const clear = !wasOut && !(knot3d && knot3d.isTravelling && knot3d.isTravelling()) ? clearSpotFor(rect) : null;
    if (clear) {
      if (!skateHome) skateHome = { x: knotPos.x, y: knotPos.y };
      moveKnotTo(clear, { persist: false, keepGuide: true, onDone: point });   // runs point() when it lands (or at once if too near to skate)
    } else point();
  }
  // The model confirmed a quick pick: its wording replaces the placeholder in
  // place. The thread does not move and nothing re-animates.
  nus.on('guide:update', (p) => {
    if (!p || (p.seq != null && targetSeq != null && p.seq !== targetSeq)) return;
    if (pendingBubble) {
      if (p.kicker != null) pendingBubble.kicker = p.kicker;
      if (p.instruction) pendingBubble.text = p.instruction;
      if (p.hint != null) pendingBubble.hint = p.hint;
      if (p.speak) pendingBubble.speak = p.speak;
      return;
    }
    if (!isShown(bubble) || bubble.dataset.task !== 'guide') return;
    if (p.kicker != null) $('#gb-kicker').textContent = p.kicker;
    if (p.instruction) $('#gb-text').textContent = p.instruction;
    if (p.hint != null) $('#gb-hint').textContent = p.hint;
    positionBubble();
    if (p.speak) say(p.speak);
  });
  // The model found nothing to point at after a quick pick: the thread goes
  // home on its own; main's explanation bubble follows by the Knot.
  nus.on('guide:retract', () => {
    stopWindowTour(false);
    hideBubble();
    pendingBubble = null;
    if (strand && strand.getState() !== 'idle') { retractOnly = true; cues.play('rewind'); strand.rewind(); }
  });
  nus.on('guide:bubble', onGuideBubble);
  function onGuideBubble(p) {
    if (!p) return;
    // The list is open and shows this card already: no second one, the words still spoken.
    if (taskPanel && taskPanel.open && p.task === 'hands' && (p.actions || []).some((a) => a.id === 'hands-yes')) { if (p.speak) say(p.speak); return; }
    if (p.task) guideTask = p.task;
    // A tour card is up: a plain line (no buttons) would sit behind the sheet,
    // so it goes into the card's status line instead, and is still spoken.
    if (tourCard && isShown(tourEl) && !(p.actions && p.actions.length) && p.task !== 'hands') { trStatus.textContent = String(p.text || ''); if (p.speak) say(p.speak); return; }
    showBubble(Object.assign({}, p, { anchor: p.anchor || 'knot' }));
  }
  nus.on('guide:done', onGuideDone);
  function onGuideDone(p) {
    clearMarks(false);
    hideBubble();
    pendingBubble = null;
    retractOnly = false;
    // "Done" is for a walkthrough that finished. A dismissal, a timeout or an
    // error just winds back; a cheerful chord after those would be wrong.
    const finished = !!(p && (p.summary || p.offerKeep));
    if (finished) { cues.play('done'); if (knot3d && knot3d.gesture) knot3d.gesture('done'); }
    const after = () => { if (p && p.offerKeep) showKeepChip(p.sessionId || null); };
    if (strand && strand.getState() !== 'idle') { afterRewind = after; setGuideState('winding'); if (!finished) cues.play('rewind'); strand.rewind(); }
    else endGuide(after);
  }

  // ---- the introduction (first run, once) ----------------------------------
  // Before the tutorial card, the Knot says hello in its own way: it draws its
  // first bubble by hand. Every bubble after this one is the quick projection.
  let introTimer = null, introUp = false;
  function playIntro() {
    if (settings && !settings.introSeen) { settings.introSeen = true; Promise.resolve(nus.settingsSet({ introSeen: true })).catch(() => {}); }
    if (!strand || guideActive() || quickOpen) { tourSend('tour-start'); return; }
    noteActivity();
    introUp = true;
    showBubble({ intro: true, anchor: 'knot', task: 'ask', kicker: 'hello', text: 'I am the Knot. I stay close, I listen, and I send a loose end to whatever needs your attention.', actions: [{ id: 'tour', label: 'Show me around', primary: true }] });
    // Left alone, it carries on to the tutorial by itself.
    clearTimeout(introTimer);
    introTimer = setTimeout(() => { if (introUp && isShown(bubble)) { hideBubble(); setTimeout(() => tourSend('tour-start'), 400); } }, 9000);
  }

  // ---- light and dark desktops ---------------------------------------------
  // Main samples how bright the screen is behind the Knot (one number, kept
  // nowhere) so the mark stays clean on a white page as well as a dark one.
  let onLight = false;
  nus.on('knot:backdrop', (p) => {
    if (!p || !Number.isFinite(p.luma)) return;
    if (knot3d && knot3d.setBackdrop) knot3d.setBackdrop(p.luma);
    // The state glows are CSS shadows round the orb. On a dark screen they read
    // as light; on a light one they are a tinted ring with a hole in it, so
    // they are switched off there (with a little hysteresis, so a mid-grey
    // screen does not flicker between the two).
    const next = onLight ? p.luma > .5 : p.luma > .62;
    if (next !== onLight) { onLight = next; $('#orb').classList.toggle('on-light', onLight); }
  });

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await nus.settingsGet();
    standalone = settings._standalone === true;
    document.documentElement.classList.toggle('standalone', standalone);
    cues.setEnabled(settings.sounds !== false);
    applyKnotPayload(settings._knotPos || { corner: settings.knotCorner || 'br' });
    applyKnotSize(settings.knotSize, false);
    // Founder machines get a debug handle so a DevTools session can drive the
    // Knot and the strand directly (used by the capture rig and the harness).
    if (settings._founderTools) window.__nus = { engine, knot: knot3d, strand, moveKnotTo, showBubble, showHint, setGuideState, syncKnotUi, applyCorner, applyKnotPos, openQuickAsk, closeQuickAsk };
    assistShortcut = (settings.shortcuts && settings.shortcuts.assist) || DEFAULT_ASSIST_SHORTCUT;
    syncAssistShortcutLabels();
    // Founder tooling (stealth, packs, résumé) exists only on machines that
    // set NUS_FOUNDER=1; everyone else never sees the rows.
    document.documentElement.classList.toggle('founder', !!settings._founderTools);
    syncRehearsalCluster();
    syncPlaceholder();
    const st = await nus.captureState();
    syncCaptureUi(st.active);
    // First run: the drawn hello, then the tutorial. After that, the tutorial alone.
    if (standalone && !settings.onboarded && !settings.introSeen) setTimeout(playIntro, 900);
    // First-run: the dashboard tour opens this tutorial at its Companion step
    // (or the student clicks the mark). Popping it on landing stole the welcome.

  })();
})();

function createPreviewBridge() {
  document.documentElement.classList.add('preview-mode');
  const listeners = new Map();
  const settings = {
    provider: 'gemini', apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '', typesafe: '' },
    models: { gemini: { fast: 'gemini-2.0-flash', smart: 'gemini-2.5-pro' } },
    shortcuts: { assist: 'CommandOrControl+Return' }, smart: false, onboarded: true,
    resumeContext: '', packPath: '', sparPath: '', speakReplies: false, shareNusContextWithProvider: false,
    _founderTools: false, _standalone: false,
  };
  return {
    platform: 'win32',
    settingsGet: async () => settings,
    settingsSet: async (patch) => Object.assign(settings, patch),
    shortcutAssistSet: async (accelerator) => ({ ok: true, accelerator }),
    captureState: async () => ({ active: false }),
    captureToggle: async () => ({ active: false }),
    packStatus: async () => ({ live: { ok: false, path: '' }, spar: { ok: false, path: '' } }),
    nusContextStatus: async () => ({ ok: true, updatedAt: new Date().toISOString() }),
    sparReset: async () => true,
    deepQuery: async () => '',
    ask: () => {}, micPcm: () => {}, systemPcm: () => {}, setIgnoreMouse: () => {}, openPane: () => {}, log: () => {},
    guideAsk: () => {}, guideDismiss: () => {}, guideKeep: () => {}, guideSkip: () => {}, strandArrived: () => {},
    knotCornerSet: async () => true,
    getZoomLevel: () => 0,
    on: (channel, callback) => listeners.set(channel, callback),
  };
}
