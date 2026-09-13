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
  let busy = false;
  let guideState = null;  // main-owned guide session state, null outside a session
  let quickOpen = false;  // the one-line quick ask by the Knot
  let aiEl = null;       // current streaming <div class="ai-text">
  let caretEl = null;
  let assistShortcut = DEFAULT_ASSIST_SHORTCUT;
  let recordingShortcut = false;

  const messages = $('#messages');

  function esc(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

  function shortcutParts(accelerator) {
    const labels = {
      CommandOrControl: nus.platform === 'darwin' ? '⌘' : 'Ctrl',
      Command: '⌘', Control: 'Ctrl', Super: 'Super',
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
    const pointingStatus = $('#inspect-shortcut-status');
    if (pointingStatus) pointingStatus.textContent = settings && settings._inspectionShortcut && !settings._inspectionShortcut.ok ? settings._inspectionShortcut.error : 'Ctrl+Shift+T: point at a control, see the Knot point to it, then optionally ask Claude.';
    const shortcutBtn = $('#shortcut-assist');
    if (shortcutBtn && !recordingShortcut) shortcutBtn.textContent = shortcutParts(assistShortcut).join(' + ');
    const placeholder = $('#placeholder');
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
    return b;
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

  function appendToken(t) {
    if (!aiEl) startAi(false);
    aiEl.dataset.raw += t;
    const span = document.createElement('span');
    span.className = 'w';
    span.textContent = t;
    aiEl.insertBefore(span, caretEl);
  }

  function finalizeAi() {
    if (!aiEl) return '';
    const raw = aiEl.dataset.raw || '';
    aiEl.innerHTML = renderMarkdown(raw);
    aiEl = null; caretEl = null;
    return raw;
  }

  // Click-through state. It lives up here, above every caller, because the
  // window's real ignore state and this variable must never diverge: a direct
  // setIgnoreMouse call that skipped this left `ignoring` stale, and then the
  // equality guard swallowed the very call that makes the overlay clickable
  // again. One setter, one state, no way back into that.
  let ignoring = null;
  function setIgnoreSafe(v) {
    if (v === ignoring) return;
    ignoring = v;
    try { nus.setIgnoreMouse(v); } catch (_) { /* preload stub */ }
  }

  // The 3D knot canvas. Falls back to the inline SVG when canvas is missing.
  // ground:false + a smaller scale: the mark floats shadow-free on the user's
  // desktop, and the extra canvas margin keeps its glow from being cut off.
  // focusGate:false: the overlay is shown inactive by design, so the Knot
  // must not drop to a third of its frame rate for never being focused.
  // pauseWhenHidden:false: the overlay runs with background throttling off, so
  // the Page Visibility API no longer tracks the window; main tells us when the
  // overlay is hidden or shown (overlay:visible) and the Knot pauses on that.
  const knot3d = window.NusKnot3D ? NusKnot3D.mount($('#knot-canvas'), { ground: false, scale: 0.285, focusGate: false, pauseWhenHidden: false, quietIdle: true }) : null;
  if (knot3d) $('#orb').classList.add('k3d');
  nus.on('overlay:visible', (p) => {
    if (!knot3d) return;
    if (p && p.visible) knot3d.resume(); else knot3d.pause();
    if (strand) { if (p && p.visible) strand.resume(); else strand.pause(); }
  });

  function syncKnotUi() {
    const toolbar = $('#toolbar');
    const panelNode = $('#panel');
    const listening = $('#stop-btn').classList.contains('active');
    const panelOpen = panelNode && !panelNode.classList.contains('collapsed');
    // A guide session (main-owned) outranks the local state ladder. Thread
    // colour = task; the Knot's glow = this state.
    const GUIDE_KNOT = { listening: 'listening', transcribing: 'thinking', reading: 'reading', thinking: 'thinking', unwinding: 'ready', pointing: 'ready', nudging: 'ready', explaining: 'ready', keeping: 'thinking', done: 'ready', winding: 'idle' };
    const state = guideState ? (GUIDE_KNOT[guideState] || 'ready') : busy ? 'thinking' : listening ? 'listening' : (panelOpen || quickOpen) ? 'ready' : 'idle';
    const copy = (guideState && {
      listening: ['Nūs listening', 'Release to send'],
      transcribing: ['Nūs transcribing', 'Microphone stopped'],
      reading: ['Nūs reading your screen', 'Amber means looking'],
      unwinding: ['Nūs unwinding', 'Following the thread'],
      pointing: ['Nūs pointing', 'Esc or click me to wind back'],
      nudging: ['Nūs has a note', 'Not now snoozes it for today'],
      explaining: ['Nūs answering', 'Esc or click me to close'],
      keeping: ['Nūs keeping that', 'Stored for later'],
      done: ['Nūs done', 'Winding back'],
    }[guideState]) || {
      idle: ['Nūs idle', 'Quietly available'],
      listening: ['Nūs recording', 'Audio capture active'],
      thinking: ['Nūs thinking', 'Working through context'],
      ready: ['Nūs ready', 'Command layer open']
    }[state];

    toolbar.dataset.knotState = state;
    toolbar.classList.toggle('panel-open', !!panelOpen);
    $('#orb').setAttribute('aria-expanded', String(!!panelOpen || quickOpen));
    $('#knot-status-title').textContent = copy[0];
    $('#knot-status-subtitle').textContent = copy[1];
    if (knot3d) knot3d.setState(guideState === 'reading' ? 'reading' : ($('#orb').classList.contains('spar') && !busy ? 'spar' : state));
  }

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
  function showTiles() { panel.classList.remove('collapsed'); syncKnotUi(); }
  function toggleTiles() { panel.classList.toggle('collapsed'); syncKnotUi(); }
  // Measured 2026-09-10 on the packaged build: after "Walk me through it" the
  // selection conversation panel stayed open over the pointed control, so the
  // person's click landed on our own panel and the screen never changed. When
  // the panel covers a pointed target it folds away; the answer stays in it.
  function collapsePanelIfCovering(bbox) {
    if (!bbox || panel.classList.contains('collapsed')) return false;
    const r = panel.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return false;
    const covers = !(r.right < bbox.x || r.left > bbox.x + bbox.w || r.bottom < bbox.y || r.top > bbox.y + bbox.h);
    if (!covers) return false;
    panel.classList.add('collapsed'); syncKnotUi();
    return true;
  }

  // ---- speech out --------------------------------------------------------
  // Lifted from the Jarvis dashboard: Edge's neural voices are free and good
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

  function plainify(text) {
    return text.replace(/```[\s\S]*?```/g, ' code block omitted ')
               .replace(/[#*_`>[\]]/g, '')
               .replace(/\(https?:[^)]+\)/g, '');
  }

  function speak(text) {
    if (!settings || !settings.speakReplies || !text) return;
    speechSynthesis.cancel();
    const plain = plainify(text).slice(0, 2200);
    if (!plain.trim()) return;
    const u = new SpeechSynthesisUtterance(plain);
    if (voice) u.voice = voice;
    u.rate = 1.05;
    speechSynthesis.speak(u);
  }

  function stopSpeaking() { try { speechSynthesis.cancel(); } catch (_) {} }

  // Voice input never implicitly opts into spoken output.
  function say(text) {
    if (!settings || !settings.speakReplies || !text) return;
    try {
      speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(plainify(String(text)).slice(0, 300));
      if (voice) u.voice = voice;
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch (_) { /* no voices on this machine */ }
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
    if (!text) { runMode('guide', ''); return; }
    input.value = ''; syncPlaceholder();
    // While rehearsing, what you type is your spoken line, not a question.
    runMode(sparring ? 'spar' : 'ask', text);
  }
  $('#send-btn').addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    // Full-vault query. Bound here rather than globally because it needs the
    // composer text. Slow (15 to 30s), so it is a between-calls tool.
    if (isCmdOrCtrl(e) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) { showStatus('Type a question first, then Ctrl+Shift+D to ask the whole vault.'); return; }
      input.value = ''; syncPlaceholder();
      setBusy(true);
      nus.deepQuery(text);
      return;
    }
    const captured = keyEventToAccelerator(e);
    if (captured.accelerator && captured.accelerator.toLowerCase() === assistShortcut.toLowerCase()) {
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
  const KNOT_CLICK_REPEAT_MS = 400; // under Windows' 500ms double-click time
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
  $('#orb').addEventListener('click', (e) => {
    if (knotClickRepeated(e)) { if (quickOpen) $('#quick-input').focus(); return; }
    // A selection answer is up: the Knot opens a follow-up on the same
    // snapshot. Esc and Done still wind it back.
    if (!quickOpen && currentInspection && guideActive()) { showInspectionComposer(currentInspection, true); return; }
    if (guideActive()) dismissGuide('knot');
    else if (quickOpen) closeQuickAsk();
    else if (!panel.classList.contains('collapsed')) toggleTiles();
    else openQuickAsk();
  });
  $('#orb').addEventListener('dblclick', (e) => { e.preventDefault(); e.stopPropagation(); });

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
      const quietBars = $('#quiet-voice-wave').children;
      for (let i = 0; i < quietBars.length; i++) {
        quietBars[i].style.transform = 'scaleY(' + (0.08 + (waveLevels[i] || 0) * 0.92).toFixed(3) + ')';
      }
    }
    waveRaf = requestAnimationFrame(paintWave);
  }

  function startWave() {
    const host = $('#voice-wave');
    if (host && !host.children.length) host.innerHTML = new Array(WAVE_BARS).fill('<i></i>').join('');
    const quietHost = $('#quiet-voice-wave');
    if (!quietHost.children.length) quietHost.innerHTML = new Array(WAVE_BARS).fill('<i></i>').join('');
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
  let micStarting = false, micEpoch = 0;
  const captureOn = () => $('#stop-btn').classList.contains('active');
  async function startMic() {
    if (micStream || micStarting) return;
    micStarting = true;
    const epoch = ++micEpoch;
    let stream = null, context = null;
    const stillWanted = () => epoch === micEpoch && (pttHeld || captureOn());
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      if (!stillWanted()) return;
      context = new AudioContext();
      if (context.state === 'suspended') await context.resume();
      await context.audioWorklet.addModule('./pcm-processor.js');
      if (!stillWanted()) return;
      micStream = stream; audioCtx = context;
      for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => {
        if (!stillWanted()) return;
        if (pttHeld) nus.pttFinish();
        else if (captureOn()) nus.captureToggle();
        showStatus('Microphone disconnected. Saving the audio already received; reconnect before recording again.');
      });
      micNode = context.createMediaStreamSource(stream);
      micProc = new AudioWorkletNode(context, 'pcm-processor', { processorOptions: { targetRate: 16000 } });
      micProc.port.onmessage = (e) => { pttHeld ? nus.pttPcm(e.data.buffer) : nus.micPcm(e.data.buffer); pushLevel(e.data.level); if (pttHeld && knot3d && knot3d.setLevel) knot3d.setLevel(Math.min(1, (e.data.level || 0) * 7)); };
      const sink = context.createGain(); sink.gain.value = 0;
      micNode.connect(micProc); micProc.connect(sink); sink.connect(context.destination);
      nus.log('mic: capturing at ' + context.sampleRate + 'Hz');
      setMicError('');
    } catch (err) {
      if (epoch !== micEpoch) return;
      const message = err && err.name === 'NotAllowedError'
        ? 'Microphone blocked. Allow Nūs in your system microphone settings, then try Talk again.'
        : err && err.name === 'NotFoundError' ? 'No microphone found. Connect one, then try Talk again.' : 'The microphone could not start. Please try again.';
      if (pttHeld) nus.pttCancel();
      stopMic();
      setMicError(message); showStatus(message);
    } finally {
      if (stream && stream !== micStream) stream.getTracks().forEach(t => t.stop());
      if (context && context !== audioCtx && context.state !== 'closed') context.close().catch(() => {});
      if (epoch === micEpoch) micStarting = false;
    }
  }

  function stopMic() {
    micEpoch++; micStarting = false;
    if (micProc) { micProc.port.onmessage = null; micProc.disconnect(); micProc = null; }
    if (micNode) { micNode.disconnect(); micNode = null; }
    if (audioCtx) { audioCtx.close(); audioCtx = null; }
    if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  }

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
  let captureSaving = false;
  nus.on('capture:finalizing', ({active}) => {
    captureSaving = !!active;
    $('#quiet-recording').classList.toggle('hidden', !active && !captureOn() && !pttHeld);
    $('#quiet-stop').disabled = !!active;
    if (active) { $('#quiet-recording-text').textContent = 'Saving transcript…'; placeByKnot($('#quiet-recording')); }
  });
  let captureStartedAt = null;
  let captureClockTimer = null;
  function captureTime() {
    const elapsed = captureStartedAt ? Math.max(0, Math.floor((Date.now() - captureStartedAt) / 1000)) : 0;
    const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const seconds = String(elapsed % 60).padStart(2, '0');
    $('#capture-clock').textContent = minutes + ':' + seconds;
    $('#quiet-recording-text').textContent = 'Recording · ' + minutes + ':' + seconds;
  }
  function syncCaptureUi(active) {
    $('#quiet-recording').classList.toggle('hidden', !active && !captureSaving);
    $('#quick-record').textContent = active ? 'Stop recording' : 'Record meeting';
    $('#quiet-stop').classList.remove('hidden');
    $('#quiet-cancel').classList.add('hidden');
    $('#quiet-retry').classList.add('hidden');
    if (active) placeByKnot($('#quiet-recording'));
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
  let voiceClock = null;
  nus.on('ptt:state', ({ held, startedAt, limitMs, handsFree }) => {
    clearInterval(voiceClock);
    pttHeld = !!held;
    $('#quiet-retry').classList.add('hidden');
    $('#quiet-stop').classList.toggle('hidden', !held);
    $('#quiet-cancel').classList.toggle('hidden', !held);
    $('#quiet-recording').classList.toggle('hidden', !held && !captureOn());
    if (held) {
      const update = () => {
        const remaining = Math.max(0, Math.ceil(((limitMs || 20000) - (Date.now() - startedAt)) / 1000));
        $('#quiet-recording-text').textContent = 'Listening · ' + remaining + 's left · ' + (handsFree ? 'Stop to send' : 'Release to send') + (remaining <= 10 ? ' · ending soon' : '');
        placeByKnot($('#quiet-recording'));
      };
      update(); voiceClock = setInterval(update, 250);
    }
    if (pttHeld) { stopSpeaking(); startWave(); startMic(); }
    else { if (knot3d && knot3d.setLevel) knot3d.setLevel(0); if (!captureOn()) { stopWave(); stopMic(); } }
  });
  const voiceBubbles = new Map();
  nus.on('voice:transcript', (turn) => {
    if (!turn || !turn.sessionId || !turn.text) return;
    let entry = voiceBubbles.get(turn.sessionId);
    if (entry && entry.revision >= turn.revision) return;
    if (!entry || !entry.node.isConnected) {
      const node = document.createElement('div'); node.className = 'user-bubble';
      messages.appendChild(node); entry = { node, revision: 0 }; voiceBubbles.set(turn.sessionId, entry);
    }
    entry.revision = turn.revision;
    entry.node.textContent = (turn.final ? '' : 'Incomplete: ') + turn.text;
    showTiles();
  });
  nus.on('voice:status', (p) => {
    $('#quiet-recording').classList.toggle('hidden', p.state === 'done');
    $('#quiet-recording-text').textContent = p.text || 'Transcribing · microphone stopped';
    $('#quiet-stop').classList.add('hidden');
    $('#quiet-cancel').classList.toggle('hidden', p.state === 'done');
    $('#quiet-retry').classList.toggle('hidden', !p.retry);
    placeByKnot($('#quiet-recording'));
  });
  nus.on('capture:state', ({ active }) => {
    syncCaptureUi(active);
    if (active) { setMicError(''); startWave(); startMic(); startSystemAudio(); }
    else { stopWave(); stopMic(); stopSystemAudio(); }
  });
  nus.on('llm:start', ({ userBubble, small }) => {
    setBusy(true);                                   // thinking paints first...
    showTiles();                                     // ...then the tiles materialize
    if (userBubble && (!messages.lastElementChild || messages.lastElementChild.textContent !== userBubble)) addUserBubble(userBubble);
    startAi(!!small);
    setBusy(true);
  });
  nus.on('llm:token', ({ text }) => appendToken(text));
  nus.on('llm:done', () => { speak(finalizeAi()); setBusy(false); });
  nus.on('llm:cancelled', () => { stopSpeaking(); finalizeAi(); setBusy(false); });
  nus.on('conversation:restore', (p) => {
    clearMessages();
    voiceBubbles.clear();
    for (const turn of p.turns || []) {
      if (turn.role === 'user') {
        const node = addUserBubble(turn.text);
        if (turn.voiceSessionId) voiceBubbles.set(turn.voiceSessionId, { node, revision: -1 });
      }
      else { startAi(false); aiEl.dataset.raw = turn.text; finalizeAi(); }
    }
  });
  nus.on('llm:busy', () => { setBusy(false); showStatus('Still working on the last one.'); });
  nus.on('llm:error', ({ message }) => {
    if (!aiEl) startAi(true);
    aiEl.dataset.raw = message; finalizeAi(); setBusy(false);
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
    showTiles(); // statuses matter (transcription off, pack missing): surface them
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
    dailyLine.classList.remove('hidden');
  });
  dailyLine.addEventListener('click', () => {
    dailyLine.classList.add('hidden');
    runMode('guide', '');
  });

  // Rehearsal tools require a briefing pack built by the vault; without one
  // (or founder mode) the cluster does not exist.
  function syncRehearsalCluster() {
    const hasPack = !!(settings && (settings.packPath || settings.sparPath));
    const founder = !!(settings && settings._founderTools);
    $('#rehearsal-cluster').classList.toggle('hidden', !(hasPack || founder));
  }

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  // Take the mouse immediately: waiting for a probe tick to notice the modal
  // is what made the panel look open but dead to clicks.
  function openSettings() { fillSettings(); scrim.classList.remove('hidden'); setIgnoreSafe(false); }
  async function closeSettings() {
    cancelShortcutRecording(); recordingPttShortcut = false;
    try { await saveSettings(); scrim.classList.add('hidden'); setIgnoreSafe(true); }
    catch (_) { $('#s-status').textContent = 'Could not save settings. Please try again.'; }
  }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });

  function fillSettings() {
    $('#knot-position').value = settings.knotCorner || 'br';
    $('#proactive-enabled').checked = settings.proactive !== false;
    $('#shortcut-ptt').value = (settings._pttShortcut || settings.shortcuts.ptt || 'Unavailable').replace('CommandOrControl', nus.platform === 'darwin' ? 'Command' : 'Ctrl');
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-nvidia').value = settings.apiKeys.nvidia || '';
    $('#resume-context').value = settings.resumeContext || '';
    $('#pack-path').value = settings.packPath || '';
    $('#spar-path').value = settings.sparPath || '';
    $('#smart-mode').checked = !!settings.smart;
    $('#speak-replies').checked = !!settings.speakReplies;
    $('#reduce-motion').checked = !!settings.reducedMotion;
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
    const stt = settings._speechProviders || 'Check voice setup in the desktop app';
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
    settings.knotCorner = $('#knot-position').value;
    applyCorner(settings.knotCorner, true);
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
    settings.proactive = $('#proactive-enabled').checked;
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
    if (!parts.length && !/^F/.test(key)) return { error: 'Include Command/Ctrl, Alt, or Shift in the shortcut.' };
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
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) { closeSettings(); return; }
    if (e.key === 'Escape' && guideActive()) { dismissGuide('esc'); return; }
    if (e.key === 'Escape' && quickOpen) { closeQuickAsk(); return; }
    if (isCmdOrCtrl(e)) {
      if (e.key === ',') { e.preventDefault(); openSettings(); }
    }
  });

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  const setIgnore = setIgnoreSafe;
  function modalOpen() {
    if (!$('#region-picker').classList.contains('hidden')) return true;
    const s = document.getElementById('settings-scrim'), o = document.getElementById('onboard-scrim');
    const saved = document.getElementById('saved-scrim');
    return (s && !s.classList.contains('hidden')) || (o && !o.classList.contains('hidden')) || (saved && !saved.classList.contains('hidden'));
  }
  function overUIAt(cssX, cssY) {
    // A modal covers the window and owns every click while it is up. Never let
    // a stray probe hand the mouse back to the desktop underneath it.
    if (modalOpen()) return true;
    const el = document.elementFromPoint(cssX, cssY);
    return !!(el && el.closest && el.closest('#knot-shell, #panel-wrap, #settings-scrim, #onboard-scrim, #saved-scrim, #quiet-recording, #daily-line, #guide-bubble, #keep-chip, #quick-ask, #knot-hint'));
  }
  document.addEventListener('mousemove', (e) => setIgnore(!overUIAt(e.clientX, e.clientY)));
  // Windows: forwarded mousemove is unreliable while click-through, so the main
  // process polls the cursor and asks us what is under it. Window coords arrive
  // in DIPs; divide by the zoom factor to get CSS pixels for elementFromPoint.
  nus.on('cursor:probe', ({ x, y }) => {
    const z = Math.pow(1.2, (nus.getZoomLevel && nus.getZoomLevel()) || 0);
    setIgnore(!overUIAt(x / z, y / z));
  });
  setIgnore(true); // start fully click-through; hovering the UI re-enables it

  // ---- onboarding / first-run tutorial -----------------------------------
  const obScrim = $('#onboard-scrim');
  // Each step highlights the real element it talks about, so the tutorial
  // points at the living UI instead of describing it from a distance.
  const OB_STEPS = [
    {
      state: 'idle',
      title: 'This is the Nūs Knot',
      target: '#orb',
      body: 'Click the Knot and type what you need help with, or choose Talk.<br><br>The thread points to one control at a time. You do the clicking. Escape winds it back.<br><br>For a local summary of your semester, choose <strong>More → What should I do?</strong>. Plan nudges can be turned off in Settings.'
    },
    ...(nus.platform === 'darwin' ? [{
      state: 'idle',
      title: 'Allow the Companion to see & hear',
      body: 'For listening and screen answers it needs two macOS permissions. Click each button, turn <strong>Nūs Companion</strong> ON in the window that opens, then come back here.<ul><li><strong>Microphone</strong>: to hear you</li><li><strong>Screen Recording</strong>: to see your screen and hear meeting audio</li></ul>',
      buttons: [
        { label: 'Open Microphone settings', action: () => nus.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => nus.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ]
    }] : []),
    {
      state: 'ready',
      title: 'Your shortcuts, anywhere',
      target: '#knot-bloom',
      body: () => `<ul><li>${shortcutKeycapsHtml(assistShortcut, 'kbd')}: <strong>What should I do?</strong> from anywhere</li><li><span class="kbd">${cmdKey}</span> <span class="kbd">⇧</span> <span class="kbd">Space</span>: hide or show the Companion</li><li><span class="kbd">${cmdKey}</span> <span class="kbd">⇧</span> <span class="kbd">X</span>: stop listening and vanish</li></ul>Type in the box for anything else. Screen guidance uses your Companion provider or the desktop Claude connection. Voice uses local transcription when available. Open Settings to see and change your voice shortcut.`
    },
    {
      state: 'idle',
      title: 'Choose what you share',
      body: () => ((nus.platform === 'darwin'
        ? 'Nūs asks macOS to exclude the Companion from many captures, but capture behavior varies by app and is <strong>not guaranteed</strong>. '
        : 'Nūs asks Windows to exclude the Companion from many captures, but capture behavior varies by app and is <strong>not guaranteed</strong>. ')
        + 'Treat it as presentation control, not a way to conceal assistance. Always follow the rules of the meeting, class, interview, or assessment you are in.<br><br>Letting the Knot read your semester when answering with AI is a separate switch in Settings, off until you turn it on. Screen guidance sends your question and one screen capture per step to your AI provider. Voice transcription runs locally when available, with configured cloud providers as fallback. Recordings appear in <strong>Knot &gt; History</strong> when transcript saving is on. Keep saves guidance locally; Jarvis export is a separate preview and confirmation.'),
      buttons: [{ label: 'Tour the desktop app', action: () => { finishOnboard(); nus.desktopTour && nus.desktopTour(); } }]
    }
  ];
  let obIndex = 0;
  // The step icon is the mark itself, tinted to the state the step teaches.
  const OB_KNOT_SVG = '<svg viewBox="0 0 88 88" class="ob-knot" aria-hidden="true">' +
    '<path d="M17 47C13 29 28 15 45 17C63 19 72 37 64 52C57 66 38 70 26 60C15 51 16 35 26 27C37 18 54 23 59 36C64 48 54 60 42 60" fill="none"/>' +
    '</svg>';
  function renderOnboard() {
    const step = OB_STEPS[obIndex];
    const icon = $('#ob-icon');
    icon.innerHTML = OB_KNOT_SVG;
    icon.dataset.state = step.state || 'idle';
    if (knot3d) knot3d.setState(step.state || 'idle');   // the Knot demos itself
    document.querySelectorAll('.ob-target').forEach((el) => el.classList.remove('ob-target'));
    document.getElementById('toolbar').classList.add('tour-open');
    if (step.target) { const t = document.querySelector(step.target); if (t) t.classList.add('ob-target'); }
    $('#ob-title').textContent = step.title;
    $('#ob-body').innerHTML = typeof step.body === 'function' ? step.body() : step.body;
    const btns = $('#ob-buttons'); btns.innerHTML = '';
    (step.buttons || []).forEach((b) => { const el = document.createElement('button'); el.textContent = b.label; el.addEventListener('click', b.action); btns.appendChild(el); });
    const dots = $('#ob-dots'); dots.innerHTML = '';
    OB_STEPS.forEach((_, i) => { const d = document.createElement('span'); if (i === obIndex) d.className = 'on'; dots.appendChild(d); });
    $('#ob-back').style.visibility = obIndex === 0 ? 'hidden' : 'visible';
    $('#ob-next').textContent = obIndex === OB_STEPS.length - 1 ? 'Done' : 'Next';
    $('#ob-skip').style.visibility = obIndex === OB_STEPS.length - 1 ? 'hidden' : 'visible';
  }
  function showOnboard() { obIndex = 0; renderOnboard(); obScrim.classList.remove('hidden'); setIgnore(false); }
  async function finishOnboard() {
    obScrim.classList.add('hidden');
    setIgnoreSafe(true);   // re-arm click-through; don't wait for a mousemove
    document.querySelectorAll('.ob-target').forEach((el) => el.classList.remove('ob-target'));
    document.getElementById('toolbar').classList.remove('tour-open');
    syncKnotUi();          // hand the Knot back to reality
    if (settings && !settings.onboarded) { settings.onboarded = true; await nus.settingsSet({ onboarded: true }); }
  }
  $('#ob-next').addEventListener('click', () => { if (obIndex === OB_STEPS.length - 1) finishOnboard(); else { obIndex++; renderOnboard(); } });
  $('#ob-back').addEventListener('click', () => { if (obIndex > 0) { obIndex--; renderOnboard(); } });
  $('#ob-skip').addEventListener('click', finishOnboard);
  $('#logo-btn').addEventListener('click', showOnboard);
  nus.on('tour:start', showOnboard);

  // Desktop link tick: lit when the desktop's shared context is present.
  async function syncDesktopLink() {
    try {
      const status = await nus.nusContextStatus();
      $('#desktop-link').classList.toggle('off', !status.ok);
    } catch (_) { /* preview stub */ }
  }
  syncDesktopLink();
  setInterval(syncDesktopLink, 120000);

  // ---- the Knot corner -------------------------------------------------
  // The Knot is pinned to one of four corners and never follows the cursor.
  // From any corner its open tail is aimed at the screen centre, so the
  // strand always leaves toward the work instead of into the bezel.
  const appEl = $('#app');
  const CORNERS = new Set(['tl', 'tr', 'bl', 'br']);
  let corner = 'br';
  function aimKnot() {
    if (!knot3d || !knot3d.setRotate) return;
    knot3d.setRotate(0);
    const seam = knot3d.getTailAnchor(0), open = knot3d.getTailAnchor(1);
    if (!seam || !open) return;
    const r = $('#orb').getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const want = Math.atan2(window.innerHeight / 2 - cy, window.innerWidth / 2 - cx);
    const have = Math.atan2(open.y - seam.y, open.x - seam.x);
    knot3d.setRotate(want - have);
  }
  function applyCorner(next, persist) {
    if (!CORNERS.has(next)) next = 'br';
    corner = next;
    appEl.dataset.corner = next;
    document.querySelectorAll('#corner-pick button').forEach((b) => b.classList.toggle('on', b.dataset.corner === next));
    requestAnimationFrame(() => { aimKnot(); if (strand) strand.relayout(); positionBubble(); placeByKnot(keepChip); placeByKnot(quickAsk); placeByKnot($('#knot-hint')); });
    if (persist && nus.knotCornerSet) Promise.resolve(nus.knotCornerSet(next)).catch(() => {});
  }
  document.querySelectorAll('#corner-pick button').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); applyCorner(b.dataset.corner, true); }));
  nus.on('knot:corner', (p) => applyCorner(p && p.corner, false));
  window.addEventListener('resize', () => requestAnimationFrame(aimKnot));

  // ---- the strand: guide sessions on screen ----------------------------
  // Main owns the session and its state machine; this side draws. A target
  // arrives in window DIPs, the strand unwinds to it, the bubble appears at
  // the tip once it lands, and any dismissal winds the thread back first.
  const strandCanvas = $('#strand-layer');
  const bubble = $('#guide-bubble');
  const keepChip = $('#keep-chip');
  let guideTask = '';
  let pendingBubble = null;   // shown when the tip arrives
  let bubbleAnchor = 'knot';
  let afterRewind = null;
  let guideVersion = null;
  let keepSession = null, keepTimer = null, bubbleRaf = null;

  const strand = (window.NusStrand && knot3d) ? NusStrand.mount(strandCanvas, knot3d, {
    onArrive() {
      if (pendingBubble) { showBubble(pendingBubble); pendingBubble = null; }
      if (guideState === 'unwinding') setGuideState('pointing');
      if (nus.strandArrived) nus.strandArrived(guideVersion);
    },
    onRewound() {
      // A fresh explanation at home may arrive while an old strand returns.
      if (bubbleAnchor !== 'knot') hideBubble();
      if (guideState === 'winding') setGuideState(null);
      const f = afterRewind; afterRewind = null;
      if (f) f();
    }
  }) : null;
  const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
  function applyMotionPreference() {
    const reduced = motionPreference.matches || !!(settings && settings.reducedMotion);
    document.documentElement.classList.toggle('reduced-motion', reduced);
    if (strand && strand.setReducedMotion) strand.setReducedMotion(reduced);
    if (knot3d && knot3d.setReducedMotion) knot3d.setReducedMotion(reduced);
  }
  motionPreference.addEventListener('change', applyMotionPreference);
  $('#reduce-motion').addEventListener('change', async (e) => {
    const value = e.target.checked;
    await nus.settingsSet({ reducedMotion: value });
    settings.reducedMotion = value;
    applyMotionPreference();
  });

  function zoomFactor() { return Math.pow(1.2, (nus.getZoomLevel && nus.getZoomLevel()) || 0); }
  function dipRectToCss(r) { const z = zoomFactor(); return { x: r.x / z, y: r.y / z, w: r.w / z, h: r.h / z }; }
  function guideActive() { return !!guideState || !!(strand && strand.getState() !== 'idle'); }

  function setGuideState(state, task) {
    guideState = state || null;
    if (task) guideTask = task;
    const orb = $('#orb');
    if (guideState) orb.dataset.state = guideState; else delete orb.dataset.state;
    syncKnotUi();
  }

  function knotAnchor() {
    const r = $('#orb').getBoundingClientRect();
    const kx = r.left + r.width / 2, ky = r.top + r.height / 2;
    const dx = window.innerWidth / 2 > kx ? 1 : -1, dy = window.innerHeight / 2 > ky ? 1 : -1;
    return { x: kx + dx * 46, y: ky + dy * 4, dx, dy };
  }
  function placeAt(el, ax, ay, dx, dy) {
    const W = window.innerWidth, H = window.innerHeight;
    const bw = el.offsetWidth, bh = el.offsetHeight;
    let left = dx >= 0 ? ax : ax - bw;
    let top = dy >= 0 ? ay : ay - bh;
    left = Math.max(8, Math.min(W - bw - 8, left));
    top = Math.max(8, Math.min(H - bh - 8, top));
    el.style.left = left + 'px'; el.style.top = top + 'px';
  }
  function placeByKnot(el) {
    if (!el || el.classList.contains('hidden')) return;
    const a = knotAnchor();
    if (el.id === 'quiet-recording' && !$('#quick-ask').classList.contains('hidden')) a.y += a.dy * ($('#quick-ask').offsetHeight + 8);
    placeAt(el, a.x, a.y, a.dx, a.dy);
  }
  function positionBubble() {
    if (bubble.classList.contains('hidden')) return;
    const tip = strand && strand.getTip(), target = strand && strand.getTarget();
    if (bubbleAnchor === 'tip' && tip && target) {
      // Away from the target, along the thread's approach, so the bubble
      // never covers the control it is talking about.
      const cx = target.x + target.w / 2, cy = target.y + target.h / 2;
      let dx = tip.x - cx, dy = tip.y - cy;
      const d = Math.hypot(dx, dy) || 1; dx /= d; dy /= d;
      placeAt(bubble, tip.x + dx * 16, tip.y + dy * 16, dx, dy);
    } else {
      placeByKnot(bubble);
    }
  }
  function trackBubble() {
    bubbleRaf = requestAnimationFrame(() => {
      positionBubble();
      if (!bubble.classList.contains('hidden')) trackBubble(); else bubbleRaf = null;
    });
  }
  function showBubble(p) {
    $('#guide-followup').classList.toggle('hidden', !p.sessionId);
    bubble.dataset.task = p.task || guideTask || '';
    $('#gb-kicker').textContent = p.kicker || '';
    $('#gb-text').textContent = p.text || '';
    $('#gb-hint').textContent = p.hint || '';
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
        else if (a.id === 'inspect-ask') showInspectionComposer(currentInspection, true);
        else if (nus.guideAsk) nus.guideAsk({ action: a.id, text: '' });
      });
      actions.appendChild(b);
    });
    bubbleAnchor = p.anchor || 'knot';
    bubble.classList.remove('hidden');
    positionBubble();
    if (!bubbleRaf) trackBubble();
    if (p.speak) say(p.speak);
  }
  function hideBubble() {
    bubble.classList.add('hidden');
    if (bubbleRaf) { cancelAnimationFrame(bubbleRaf); bubbleRaf = null; }
  }

  // ---- the quick ask ---------------------------------------------------
  // Typing is the everyday path: one line by the Knot, Enter sends, Esc
  // closes, the dots open the full sheet for anyone who wants the verbs.
  const quickAsk = $('#quick-ask');
  const quickInput = $('#quick-input');
  // Native select popups live outside this window's DOM. Cursor polling can
  // mistake the open popup for empty desktop and switch it to click-through.
  // Inline mode buttons stay inside our existing, reliable hit-test surface.
  function setQuickIntent(value) {
    $('#quick-intent').value = value;
    for (const button of document.querySelectorAll('#quick-modes [data-intent]')) button.setAttribute('aria-pressed', String(button.dataset.intent === value));
    $('#quick-mode-hint').textContent = value === 'ask' ? 'Ask without sharing your screen.' : value === 'guide' ? (currentInspection ? 'Guide using this selected snapshot. Send shares the preview with Claude.' : 'Guide reads the screen for each step. You do the clicking.') : currentInspection?.source === 'point-context' ? 'Tell me the issue, or press Enter for Claude to look at this preview and ask what you need. Only Send shares it.' : currentInspection?.imageDataUrl ? 'Send shares only this preview with Claude. You can change the selected region first.' : 'Use Ctrl+Shift+T anywhere on the Knot display to select what you need help with.';
    placeByKnot(quickAsk);
  }
  for (const button of document.querySelectorAll('#quick-modes [data-intent]')) button.addEventListener('click', () => { setQuickIntent(button.dataset.intent); quickInput.focus(); });
  $('#quick-intent').addEventListener('change', () => setQuickIntent($('#quick-intent').value));
  $('#guide-followup').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#guide-followup-input'); const text = input.value.trim();
    if (!text) return;
    nus.guideAsk({ text, source: 'typed' }); input.value = '';
  });
  function openQuickAsk() {
    answerKeep(false, true);
    panel.classList.add('collapsed');
    keepChip.classList.add('hidden');
    quickOpen = true;
    quickAsk.classList.remove('hidden');
    placeByKnot(quickAsk);
    setIgnoreSafe(false);
    quickInput.value = '';
    quickInput.focus();
    syncKnotUi();
  }
  function closeQuickAsk() {
    quickOpen = false;
    quickAsk.classList.add('hidden');
    quickInput.blur();
    setIgnoreSafe(modalOpen() ? false : true);
    syncKnotUi();
  }
  function sendQuickAsk() {
    const intent = $('#quick-intent').value;
    if ((intent === 'explain' || intent === 'fix' || (currentInspection && intent === 'guide')) && !(currentInspection && currentInspection.imageDataUrl)) {
      $('#quick-mode-hint').textContent = 'No selected image yet. Point at the problem and press Ctrl+Shift+T, or choose Select region when available.';
      quickInput.focus(); return;
    }
    const text = quickInput.value.trim() || (currentInspection && intent !== 'ask' ? (currentInspection.source === 'point-context' ? 'Briefly describe what you can see around my chosen spot, then ask what issue I need help with. Do not assume anything is broken.' : intent === 'fix' ? 'Help me fix this.' : intent === 'guide' ? 'Explain the next step for this selection.' : 'Explain this selection.') : '');
    if (!text) { quickInput.focus(); return; }
    closeQuickAsk();
    if (currentInspection && intent !== 'ask') nus.inspectSubmit({ id: currentInspection.id, text: (intent === 'fix' ? 'Help me fix this: ' : '') + text, intent });
    else if (intent === 'guide' && nus.guideAsk) nus.guideAsk({ text, source: 'typed' });
    else { if (currentInspection) { currentInspection = null; nus.inspectCancel(); } nus.ask({ mode: 'ask', text, screen: false }); }
  }
  let currentInspection = null;
  // The composer over a selection: on a fresh snapshot, and again for a
  // follow-up about the same snapshot (Knot click or "Ask more" while the
  // answer is up). Measured 2026-09-10: without the follow-up path a Knot
  // click cleared the selection, so the promised same-snapshot follow-up
  // had no way in from the UI.
  function showInspectionComposer(p, followUp) {
    if (!p) return;
    currentInspection = p;
    openQuickAsk();
    $('#inspect-context').classList.remove('hidden');
    $('#inspect-context').textContent = (p.source === 'point-context' ? 'Your chosen spot. This nearby-area preview is not a detected control.' : p.bbox ? (p.source === 'user-selected' ? 'Your region, not a verified control.' : 'Selected: ' + (p.name || p.type) + '.') : 'No control found. Select a region.') + (followUp ? ' Follow-up uses the same snapshot, no new capture.' : ' Send shares only the preview with Claude.') + ' Snapshot: ' + new Date(p.createdAt).toLocaleTimeString() + '.';
    $('#inspect-preview').classList.toggle('hidden', !p.imageDataUrl);
    if (p.imageDataUrl) $('#inspect-preview').src = p.imageDataUrl;
    else $('#inspect-preview').removeAttribute('src');
    $('#inspect-region').classList.toggle('hidden', !p.canReselect || !!followUp);
    setQuickIntent(p.bbox ? 'explain' : 'ask');
    quickInput.placeholder = followUp ? 'Ask more about this' : p.source === 'point-context' ? 'What’s happening here? What do you need?' : 'What do you want to understand?';
    placeByKnot(quickAsk);
  }
  nus.on('inspect:ready', (p) => showInspectionComposer(p, false));
  $('#inspect-preview').addEventListener('load', () => placeByKnot(quickAsk));
  nus.on('inspect:cleared', () => {
    currentInspection = null;
    $('#inspect-context').classList.add('hidden');
    $('#inspect-preview').classList.add('hidden'); $('#inspect-preview').removeAttribute('src');
    $('#inspect-region').classList.add('hidden');
    $('#region-picker').classList.add('hidden');
    setQuickIntent('ask');
    quickInput.placeholder = 'Ask Nūs anything';
  });
  nus.on('inspect:failed', p => {
    hideHint();
    openQuickAsk();
    $('#inspect-context').classList.remove('hidden');
    $('#inspect-context').textContent = p.message + ' Point at the problem and press Ctrl+Shift+T to retry, or Ask without sharing your screen.';
    setQuickIntent('ask');
    placeByKnot(quickAsk);
  });
  const regionPicker = $('#region-picker');
  let regionStart = null;
  $('#inspect-region').addEventListener('click', () => {
    regionPicker.classList.remove('hidden'); setIgnoreSafe(false); regionPicker.tabIndex = 0; regionPicker.focus();
  });
  regionPicker.addEventListener('pointerdown', (e) => {
    regionStart = { x: e.clientX, y: e.clientY }; regionPicker.setPointerCapture(e.pointerId);
  });
  regionPicker.addEventListener('pointermove', (e) => {
    if (!regionStart) return;
    const box = $('#region-box');
    Object.assign(box.style, { left: Math.min(regionStart.x, e.clientX) + 'px', top: Math.min(regionStart.y, e.clientY) + 'px', width: Math.abs(regionStart.x - e.clientX) + 'px', height: Math.abs(regionStart.y - e.clientY) + 'px' });
  });
  regionPicker.addEventListener('pointerup', (e) => {
    if (!regionStart || !currentInspection) return;
    const z = zoomFactor();
    const rect = { x: Math.min(regionStart.x, e.clientX) * z, y: Math.min(regionStart.y, e.clientY) * z, w: Math.abs(regionStart.x - e.clientX) * z, h: Math.abs(regionStart.y - e.clientY) * z };
    regionStart = null; regionPicker.classList.add('hidden');
    nus.inspectRegion({ id: currentInspection.id, rect });
  });
  regionPicker.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); regionStart = null; regionPicker.classList.add('hidden'); quickInput.focus(); } });
  quickInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); currentInspection = null; if (nus.inspectCancel) nus.inspectCancel(); closeQuickAsk(); return; }
    if (e.key !== 'Enter' || e.shiftKey) return;
    e.preventDefault();
    sendQuickAsk();
  });
  $('#quick-send').addEventListener('click', sendQuickAsk);
  $('#quick-talk').addEventListener('click', async () => { closeQuickAsk(); await nus.pttToggle(); });
  $('#quick-record').addEventListener('click', () => { closeQuickAsk(); toggleCaptureFromUi(); });
  $('#quiet-stop').addEventListener('click', () => { if (pttHeld) nus.pttToggle(); else if (captureOn()) toggleCaptureFromUi(); });
  $('#quiet-cancel').addEventListener('click', () => { nus.pttCancel(); $('#quiet-recording').classList.add('hidden'); });
  $('#quiet-retry').addEventListener('click', () => nus.pttRetry());
  $('#quick-settings').addEventListener('click', () => { closeQuickAsk(); openSettings(); });
  let exportKey = null;
  async function openSaved() {
    closeQuickAsk();
    $('#saved-scrim').classList.remove('hidden');
    $('#saved-export').classList.add('hidden');
    $('#saved-status').textContent = '';
    setIgnoreSafe(false);
    const list = $('#saved-list'); list.replaceChildren();
    try {
      const entries = await nus.walkthroughList();
      if (!Array.isArray(entries)) throw new Error('Saved walkthroughs are unavailable.');
      if (!entries.length) list.textContent = 'No saved walkthroughs yet. Choose Keep after guidance to save one.';
      for (const entry of entries) {
        const row = document.createElement('div'); row.className = 'saved-item';
        const title = document.createElement('strong'); title.textContent = entry.task;
        const detail = document.createElement('small'); detail.textContent = `${entry.app.process} · ${entry.steps} step${entry.steps === 1 ? '' : 's'}${entry.stale ? ' · Needs a fresh walkthrough' : ''}`;
        const preview = document.createElement('button'); preview.textContent = 'Preview Jarvis export';
        preview.onclick = async () => {
          const result = await nus.walkthroughPreview(entry.key);
          if (!result.ok) { $('#saved-status').textContent = result.error; return; }
          exportKey = result.vaultOk ? entry.key : null; $('#saved-destination').textContent = result.vaultOk ? 'Destination: ' + result.dir : 'Jarvis vault not found. Set its location before exporting.'; $('#saved-export-confirm').disabled = !result.vaultOk; $('#saved-preview').textContent = result.content; $('#saved-export').classList.remove('hidden');
        };
        const forget = document.createElement('button'); forget.textContent = 'Forget walkthrough';
        forget.onclick = async () => { const result = await nus.walkthroughForget(entry.key); if (result.ok) openSaved(); else $('#saved-status').textContent = result.error; };
        row.append(title, detail, preview, forget); list.append(row);
      }
    } catch (e) { $('#saved-status').textContent = e.message || 'Could not load saved walkthroughs.'; }
    $('#saved-close').focus();
  }
  function closeSaved() { $('#saved-scrim').classList.add('hidden'); exportKey = null; openQuickAsk(); }
  $('#quick-saved').addEventListener('click', openSaved);
  $('#saved-close').addEventListener('click', closeSaved);
  $('#saved-scrim').addEventListener('click', e => { if (e.target === $('#saved-scrim')) closeSaved(); });
  $('#saved-history').addEventListener('click', () => nus.desktopHistory());
  $('#saved-export-confirm').addEventListener('click', async () => {
    if (!exportKey) return;
    const b = $('#saved-export-confirm'); b.disabled = true;
    try { const result = await nus.walkthroughExport(exportKey); $('#saved-status').textContent = result.ok ? 'Exported to your Jarvis vault.' : result.error; if (result.ok) { exportKey = null; $('#saved-export').classList.add('hidden'); } }
    catch (_) { $('#saved-status').textContent = 'Export failed. Please try again.'; } finally { b.disabled = false; }
  });
  let recordingPttShortcut = false;
  $('#shortcut-ptt-save').addEventListener('click', () => { recordingPttShortcut = true; $('#shortcut-ptt').value = 'Press a new shortcut'; $('#shortcut-ptt').focus(); });
  $('#shortcut-ptt').addEventListener('keydown', async e => {
    if (!recordingPttShortcut) return;
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { recordingPttShortcut = false; fillSettings(); return; }
    const next = keyEventToAccelerator(e);
    if (next.error) { $('#ptt-shortcut-status').textContent = next.error; return; }
    const result = await nus.shortcutPttSet(next.accelerator);
    $('#ptt-shortcut-status').textContent = result.ok ? 'Voice shortcut updated.' : result.error;
    if (result.ok) { recordingPttShortcut = false; settings._pttShortcut = result.accelerator; settings.shortcuts.ptt = result.accelerator; $('#shortcut-ptt').value = result.accelerator.replace('CommandOrControl', nus.platform === 'darwin' ? 'Command' : 'Ctrl'); }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !$('#saved-scrim').classList.contains('hidden')) { e.preventDefault(); closeSaved(); } });
  $('#quick-more').addEventListener('click', (e) => { e.stopPropagation(); closeQuickAsk(); showTiles(); });

  // Wind back: Esc, a click on the Knot, a bubble's own dismiss, or main.
  function dismissGuide(reason) {
    stopSpeaking();
    hideBubble();
    pendingBubble = null;
    keepChip.classList.add('hidden');
    if (quickOpen) closeQuickAsk();
    if (strand && strand.getState() !== 'idle') { setGuideState('winding'); strand.rewind(); }
    else setGuideState(null);
    if (nus.guideDismiss) nus.guideDismiss(reason);
  }

  // The consent chip: Skip is the default and the timeout; Keep is explicit.
  function showKeepChip(sessionId) {
    keepSession = sessionId;
    $('#keep-text').textContent = 'Save this task and its steps locally? No audio or screenshots.';
    $('#keep-yes').classList.remove('hidden');
    $('#keep-no').classList.remove('hidden');
    keepChip.classList.remove('hidden');
    placeByKnot(keepChip);
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => answerKeep(false, true), 12000);
  }
  async function answerKeep(keep, auto) {
    clearTimeout(keepTimer);
    if (keepChip.classList.contains('hidden')) return;
    if (keep) {
      let result;
      try { result = await nus.guideKeep(keepSession); } catch (_) { result = { ok: false }; }
      if (!result || !result.ok) { $('#keep-text').textContent = 'Could not save. Try Keep again or Skip.'; return; }
    } else if (nus.guideSkip) nus.guideSkip(keepSession);
    $('#keep-text').textContent = keep ? 'Kept in Nūs. Jarvis export is in Saved.' : (auto ? 'Forgotten.' : 'Forgotten. Nothing kept.');
    $('#keep-yes').classList.add('hidden');
    $('#keep-no').classList.add('hidden');
    keepTimer = setTimeout(() => keepChip.classList.add('hidden'), auto ? 500 : 1600);
  }
  $('#keep-yes').addEventListener('click', (e) => { e.stopPropagation(); answerKeep(true, false); });
  $('#keep-no').addEventListener('click', (e) => { e.stopPropagation(); answerKeep(false, false); });

  // The app hint: the Knot loosens a few pixels and says three words. It
  // goes away on its own; clicking it opens the quick ask.
  const knotHint = $('#knot-hint');
  let hintTimer = null;
  nus.on('guide:hint', (p) => {
    if (!p || !p.text) return;
    knotHint.textContent = p.text;
    knotHint.title = p.hint || '';
    knotHint.classList.remove('hidden');
    placeByKnot(knotHint);
    if (knot3d && knot3d.setUnravel && !(strand && strand.getState() !== 'idle')) knot3d.setUnravel(0.14);
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, Number(p.ms) || 7000);
  });
  function hideHint() {
    clearTimeout(hintTimer);
    if (knotHint.classList.contains('hidden')) return;
    knotHint.classList.add('hidden');
    if (knot3d && knot3d.setUnravel && !(strand && strand.getState() !== 'idle')) knot3d.setUnravel(0);
  }
  knotHint.addEventListener('click', (e) => { e.stopPropagation(); hideHint(); openQuickAsk(); });

  nus.on('guide:state', (p) => setGuideState(p && p.state, p && p.task));
  nus.on('context:used', (p) => {
    const labels = (p.sources || []).filter((s) => !s.omitted).map((s) => s.source + (s.freshness === 'possibly-stale' ? ' (may be stale)' : ''));
    $('#context-used').textContent = labels.length ? 'Context: ' + labels.join(', ') : 'Context: this conversation only';
  });
  nus.on('guide:target', (p) => {
    if (!strand || !p || !p.bbox) return;
    guideVersion = { sessionId: p.sessionId, generation: p.generation };
    hideBubble();
    keepChip.classList.add('hidden');
    collapsePanelIfCovering(p.bbox);
    const task = p.task || 'guide';
    setGuideState('unwinding', task);
    pendingBubble = {
      sessionId: p.sessionId,
      kicker: p.kicker != null ? p.kicker : (p.step ? 'step ' + p.step + ' of ' + (p.stepCount || '?') : ''),
      text: p.instruction || p.label || '',
      hint: p.hint || '',
      actions: p.actions || [],
      task,
      anchor: 'tip',
      speak: p.speak,
    };
    strand.setTarget(dipRectToCss(p.bbox), { task });
    // Text and actions are usable while the strand travels.
    if (pendingBubble) { showBubble(pendingBubble); pendingBubble = null; }
  });
  nus.on('guide:bubble', (p) => {
    if (!p) return;
    if (p.task) guideTask = p.task;
    showBubble(Object.assign({}, p, { anchor: p.anchor || 'knot' }));
  });
  nus.on('guide:done', (p) => {
    guideVersion = null;
    hideBubble();
    pendingBubble = null;
    const after = () => { if (p && p.offerKeep) showKeepChip(p.sessionId || null); };
    if (strand && strand.getState() !== 'idle') { afterRewind = after; setGuideState('winding'); strand.rewind(); }
    else { setGuideState(null); after(); }
  });

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await nus.settingsGet();
    applyMotionPreference();
    applyCorner(settings.knotCorner || 'br', false);
    // Founder machines get a debug handle so a DevTools session can drive the
    // Knot and the strand directly (used by the capture rig and the harness).
    if (settings._founderTools) window.__nus = { knot: knot3d, strand, setGuideState, syncKnotUi, applyCorner, openQuickAsk, closeQuickAsk };
    assistShortcut = (settings.shortcuts && settings.shortcuts.assist) || DEFAULT_ASSIST_SHORTCUT;
    syncAssistShortcutLabels();
    // Founder tooling (stealth, packs, résumé) exists only on machines that
    // set NUS_FOUNDER=1; everyone else never sees the rows.
    document.documentElement.classList.toggle('founder', !!settings._founderTools);
    syncRehearsalCluster();
    syncPlaceholder();
    const st = await nus.captureState();
    syncCaptureUi(st.active);
    // First-run: the dashboard tour opens this tutorial at its Companion step
    // (or the student clicks the mark). Popping it on landing stole the welcome.

  })();
})();

function createPreviewBridge() {
  document.documentElement.classList.add('preview-mode');
  const listeners = new Map();
  const settings = {
    provider: 'gemini', apiKeys: { openai: '', anthropic: '', gemini: '', nvidia: '' },
    models: { gemini: { fast: 'gemini-2.0-flash', smart: 'gemini-2.5-pro' } },
    shortcuts: { assist: 'CommandOrControl+Return' }, smart: false, onboarded: true,
    resumeContext: '', packPath: '', sparPath: '', speakReplies: false, shareNusContextWithProvider: false,
    _founderTools: false,
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
