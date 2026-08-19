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
  $('#smart-toggle .ic').innerHTML = icon('zap', { size: 14 });
  $('#more-btn').innerHTML = icon('more-horizontal', { size: 18 });
  $('#send-btn').innerHTML = icon('play', { size: 15 });

  // ---- state -------------------------------------------------------------
  let settings = null;
  let busy = false;
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
    const shortcutBtn = $('#shortcut-assist');
    if (shortcutBtn && !recordingShortcut) shortcutBtn.textContent = shortcutParts(assistShortcut).join(' + ');
    const placeholder = $('#placeholder');
    if (placeholder) placeholder.innerHTML = 'Ask about your screen or conversation, or ' + shortcutKeycapsHtml(assistShortcut) + ' for Assist';
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
  const knot3d = window.NusKnot3D ? NusKnot3D.mount($('#knot-canvas'), { ground: false, scale: 0.285 }) : null;
  if (knot3d) $('#orb').classList.add('k3d');

  function syncKnotUi() {
    const toolbar = $('#toolbar');
    const panelNode = $('#panel');
    const listening = $('#stop-btn').classList.contains('active');
    const panelOpen = panelNode && !panelNode.classList.contains('collapsed');
    const state = busy ? 'thinking' : listening ? 'listening' : panelOpen ? 'ready' : 'idle';
    const copy = {
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
    document.querySelectorAll('.knot-state').forEach((button) => {
      button.classList.toggle('active', button.dataset.knotState === state);
      button.setAttribute('aria-pressed', String(button.dataset.knotState === state));
    });
    if (knot3d) knot3d.setState($('#orb').classList.contains('spar') && !busy ? 'spar' : state);
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

  // ---- actions -----------------------------------------------------------
  async function runMode(mode, text) {
    if (busy) return;
    const ready = await (nus.aiReady ? nus.aiReady() : { ok: true });
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
    if (!text) { runMode('assist', ''); return; }
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
      e.preventDefault(); runMode('assist', ''); return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) { e.preventDefault(); send(); }
  });

  // Smart toggle
  const smartBtn = $('#smart-toggle');
  smartBtn.addEventListener('click', async () => {
    settings.smart = !settings.smart;
    smartBtn.classList.toggle('on', settings.smart);
    await nus.settingsSet({ smart: settings.smart });
  });

  // The Knot is the show/hide switch for the existing command sheet.
  $('#orb').addEventListener('click', toggleTiles);

  function toggleCaptureFromUi() {
    const turningOn = !$('#stop-btn').classList.contains('active');
    if (turningOn) startSystemAudio();
    nus.captureToggle();
  }
  $('#stop-btn').addEventListener('click', toggleCaptureFromUi);

  document.querySelectorAll('.knot-state').forEach((button) => {
    button.addEventListener('click', () => {
      const state = button.dataset.knotState;
      if (state === 'idle') {
        if ($('#stop-btn').classList.contains('active')) nus.captureToggle();
        panel.classList.add('collapsed');
        syncKnotUi();
        return;
      }
      if (state === 'listening') {
        toggleCaptureFromUi();
        return;
      }
      if (state === 'thinking') {
        runMode('assist', '');   // sets busy (thinking) BEFORE the tiles paint
        showTiles();
        return;
      }
      showTiles();
      $('#input').focus();
    });
  });

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
  async function startMic() {
    if (micStream) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } });
      // Do NOT force sampleRate here: some Windows drivers reject the context
      // outright, which is why capture could silently produce nothing. Take
      // whatever rate we get and downsample inside the worklet.
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      await audioCtx.audioWorklet.addModule('./pcm-processor.js');
      micNode = audioCtx.createMediaStreamSource(micStream);
      micProc = new AudioWorkletNode(audioCtx, 'pcm-processor', { processorOptions: { targetRate: 16000 } });
      micProc.port.onmessage = (e) => { nus.micPcm(e.data.buffer); pushLevel(e.data.level); };
      const sink = audioCtx.createGain(); sink.gain.value = 0; // run processor silently
      micNode.connect(micProc); micProc.connect(sink); sink.connect(audioCtx.destination);
      const label = micStream.getAudioTracks()[0]?.label || 'default device';
      nus.log('mic: capturing at ' + audioCtx.sampleRate + 'Hz via ' + label);
      setMicError('');
    } catch (err) {
      const message = (err && err.name === 'NotAllowedError')
        ? 'Microphone blocked. Allow it in Windows Settings > Privacy > Microphone, then click Listen again.'
        : (err && err.name === 'NotFoundError')
          ? 'No microphone found. Plug one in and click Listen again.'
          : 'Microphone failed: ' + (err && err.message);
      nus.log('mic error: ' + (err && err.message));
      setMicError(message);
      showStatus(message);
    }
  }

  function stopMic() {
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
  nus.on('capture:state', ({ active }) => {
    syncCaptureUi(active);
    if (active) { setMicError(''); startWave(); startMic(); startSystemAudio(); }
    else { stopWave(); stopMic(); stopSystemAudio(); }
  });
  nus.on('llm:start', ({ userBubble, small }) => {
    setBusy(true);                                   // thinking paints first...
    showTiles();                                     // ...then the tiles materialize
    clearMessages();
    if (userBubble) addUserBubble(userBubble);
    startAi(!!small);
    setBusy(true);
  });
  nus.on('llm:token', ({ text }) => appendToken(text));
  nus.on('llm:done', () => { speak(finalizeAi()); setBusy(false); });
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
      const row = document.getElementById('action-row');
      row.parentNode.insertBefore(el, row); // top of the controls tile
    }
    showTiles(); // statuses matter (transcription off, pack missing): surface them
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => el.classList.remove('show'), 11000);
  }
  nus.on('status', ({ message }) => { nus.log('[status] ' + message); showStatus(message); });

  // ---- settings ----------------------------------------------------------
  const scrim = $('#settings-scrim');
  // Take the mouse immediately: waiting for a probe tick to notice the modal
  // is what made the panel look open but dead to clicks.
  function openSettings() { fillSettings(); scrim.classList.remove('hidden'); setIgnoreSafe(false); }
  function closeSettings() { cancelShortcutRecording(); saveSettings(); scrim.classList.add('hidden'); setIgnoreSafe(true); }
  $('#more-btn').addEventListener('click', openSettings);
  $('#s-close').addEventListener('click', closeSettings);
  scrim.addEventListener('click', (e) => { if (e.target === scrim) closeSettings(); });

  function fillSettings() {
    document.querySelectorAll('#provider-seg button').forEach((b) => b.classList.toggle('on', b.dataset.provider === settings.provider));
    $('#key-openai').value = settings.apiKeys.openai || '';
    $('#key-anthropic').value = settings.apiKeys.anthropic || '';
    $('#key-gemini').value = settings.apiKeys.gemini || '';
    $('#key-nvidia').value = settings.apiKeys.nvidia || '';
    $('#resume-context').value = settings.resumeContext || '';
    $('#pack-path').value = settings.packPath || '';
    $('#spar-path').value = settings.sparPath || '';
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
    settings.apiKeys.openai = $('#key-openai').value.trim();
    settings.apiKeys.anthropic = $('#key-anthropic').value.trim();
    settings.apiKeys.gemini = $('#key-gemini').value.trim();
    settings.apiKeys.nvidia = $('#key-nvidia').value.trim();
    settings.resumeContext = $('#resume-context').value.trim();
    settings.packPath = $('#pack-path').value.trim();
    settings.sparPath = $('#spar-path').value.trim();
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
    if (e.key === 'Escape' && !scrim.classList.contains('hidden')) closeSettings();
    if (isCmdOrCtrl(e)) {
      if (e.key === ',') { e.preventDefault(); openSettings(); }
    }
  });

  // UI Zoom buttons (text only)
  let currentZoom = 1;
  function updateZoom(delta) {
    currentZoom = Math.max(0.5, Math.min(3, currentZoom + delta));
    document.documentElement.style.setProperty('--text-zoom', currentZoom);
  }
  $('#zoom-in-btn').addEventListener('click', () => updateZoom(0.1));
  $('#zoom-out-btn').addEventListener('click', () => updateZoom(-0.1));

  // ---- click-through: only the UI blocks the mouse; empty gaps pass to your screen ----
  const setIgnore = setIgnoreSafe;
  function modalOpen() {
    const s = document.getElementById('settings-scrim'), o = document.getElementById('onboard-scrim');
    return (s && !s.classList.contains('hidden')) || (o && !o.classList.contains('hidden'));
  }
  function overUIAt(cssX, cssY) {
    // A modal covers the window and owns every click while it is up. Never let
    // a stray probe hand the mouse back to the desktop underneath it.
    if (modalOpen()) return true;
    const el = document.elementFromPoint(cssX, cssY);
    return !!(el && el.closest && el.closest('#knot-shell, #panel-wrap, #settings-scrim, #onboard-scrim'));
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
      body: 'One continuous loop, no beginning, no end. It floats at the edge of your screen, tumbling quietly while it waits. It can <strong>see the screen you choose</strong> and <strong>listen when you switch it on</strong>, and it answers from your own prepared material.<br><br>Everything blooms out of the Knot: hover it now and watch.'
    },
    {
      state: 'listening',
      title: 'Four states, one glance',
      target: '#knot-bloom',
      body: 'The capsule beside the Knot shows what Nūs is doing: <strong>Idle</strong> (quiet), <strong>Listen</strong> (mic + meeting audio on, the Knot turns teal), <strong>Think</strong> (working, it speeds up and brightens), <strong>Ready</strong> (command layer open). The chips are also buttons; clicking Listen starts a capture session that lands in your history.'
    },
    ...(nus.platform === 'darwin' ? [{
      state: 'idle',
      title: 'Allow the Companion to see & hear',
      body: 'It needs two macOS permissions. Click each button, turn <strong>Nūs Companion</strong> ON in the window that opens, then come back here.<ul><li><strong>Microphone</strong>: to hear you</li><li><strong>Screen Recording</strong>: to see your screen and hear meeting audio</li></ul>',
      buttons: [
        { label: 'Open Microphone settings', action: () => nus.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone') },
        { label: 'Open Screen Recording settings', action: () => nus.openPane('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture') }
      ]
    }] : []),
    {
      state: 'thinking',
      title: 'Give the Knot a Gemini key',
      body: 'This is the one thing you have to do. The Knot runs on <strong>your own</strong> key, separate from the desktop app\'s Claude key, because it watches your screen live and that has to stay fast and cheap.<br><br><strong>Recommended: <span class="hl">Google Gemini</span></strong> (free tier at <span class="hl">aistudio.google.com/apikey</span>) because one key covers both answering and speech-to-text for listening. <span class="hl">OpenAI</span>, <span class="hl">Anthropic</span>, or <span class="hl">Nvidia</span> also work; with OpenAI, listening needs Whisper access on that key.<br><br>Paste it below, or in the desktop app under <strong>Settings &gt; Companion AI key</strong>. Same key either way. The pre-call brief works with no key at all.',
      buttons: [{ label: 'Open Settings and paste it', action: () => { finishOnboard(); openSettings(); } }]
    },
    {
      state: 'ready',
      title: 'Driving it: the commands',
      target: '#knot-bloom',
      body: '<strong>Click the Knot</strong> to open this command sheet, then type a question and press Enter, or <span class="hl">Ctrl+Enter</span> anywhere for Assist. The buttons above the box are the same actions.<br><br><strong>Hotkeys, anywhere on your machine:</strong><ul><li><span class="hl">Ctrl+Shift+Space</span> hide or show the Companion</li><li><span class="hl">Ctrl+Shift+K</span> hide just the Knot mark, everything still works</li><li><span class="hl">Ctrl+Shift+X</span> panic: stop listening and vanish</li><li><span class="hl">Ctrl+Shift+N</span> numbers, <span class="hl">Ctrl+Shift+O</span> objection, <span class="hl">Ctrl+Shift+R</span> rehearsal</li></ul>I keep running after you close the desktop window, and the tray icon brings the dashboard back.'
    },
    {
      state: 'idle',
      title: 'Choose what you share',
      body: (nus.platform === 'darwin'
        ? 'Nūs asks macOS to exclude the Companion from many captures, but capture behavior varies by app and is <strong>not guaranteed</strong>. '
        : 'Nūs asks Windows to exclude the Companion from many captures, but capture behavior varies by app and is <strong>not guaranteed</strong>. ')
        + 'Treat it as presentation control, not a way to conceal assistance. Always follow the rules of the meeting, class, interview, or assessment you are in.<br><br>Letting the Knot read your semester when answering with AI is a separate switch in Settings, off until you turn it on. Nothing leaves this machine without it.'
    },
    {
      state: 'ready',
      title: 'Your desktop brain',
      body: () => `The Knot is one half of Nūs; the desktop app is the other. Every capture session lands there under <strong>Knot &gt; History</strong>, searchable and uploadable to your vault.<br><br>Hotkeys:<ul><li>${shortcutKeycapsHtml(assistShortcut, 'kbd')}: <strong>Assist</strong> with whatever's on screen or being said</li><li><span class="kbd">${cmdKey}</span> <span class="kbd">⇧</span> <span class="kbd">Space</span>: hide or show the Companion</li><li><span class="kbd">${cmdKey}</span> <span class="kbd">⇧</span> <span class="kbd">K</span>: hide just the Knot mark</li><li><span class="kbd">${cmdKey}</span> <span class="kbd">⇧</span> <span class="kbd">X</span>: stop listening and vanish</li></ul>Reopen this guide from the <strong>?</strong> in the Knot's capsule, or from the desktop app's Knot pane.`,
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

  // ---- boot --------------------------------------------------------------
  (async function boot() {
    settings = await nus.settingsGet();
    assistShortcut = (settings.shortcuts && settings.shortcuts.assist) || DEFAULT_ASSIST_SHORTCUT;
    syncAssistShortcutLabels();
    smartBtn.classList.toggle('on', !!settings.smart);
    syncPlaceholder();
    const st = await nus.captureState();
    syncCaptureUi(st.active);
    if (!settings.onboarded) showOnboard();

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
    getZoomLevel: () => 0,
    on: (channel, callback) => listeners.set(channel, callback),
  };
}
