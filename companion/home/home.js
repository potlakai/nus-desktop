(() => {
  'use strict';
  const api = window.home;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = s => String(s ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let view = 'start', saved = 'history', selectedSession = null, currentStatus = null, searchSeq = 0;
  const titles = { start: 'Dashboard', mynus: 'My Nūs', map: 'Map', saved: 'Saved', folders: 'Folders', settings: 'Settings', feedback: 'Feedback' };
  // Apple review fix 7: a plain "Saved" is a toast that fades after 3 s; an
  // error stays, next to the control that caused it when there is one.
  let toastTimer = null;
  function toast(text) { const t = $('#toast'); clearTimeout(toastTimer); t.textContent = text || ''; t.hidden = !text; if (text) toastTimer = setTimeout(() => { t.hidden = true; }, 3000); }
  function notice(text, error = false) { if (!error) { clearNotice(); toast(text); return; } $('#notice').textContent = text; $('#notice').classList.add('error'); }
  function clearNotice() { $('#notice').textContent = ''; $('#notice').classList.remove('error'); $$('.row-error').forEach(el => el.remove()); }
  const ROW = '.key-row,.check,.field,.memory-import,.memory-form,.folder-actions,.start-actions,.item-head,form';
  const rowOf = el => el && el.closest ? el.closest(ROW) : null;
  function rowError(el, text) { const row = rowOf(el); if (!row || !row.closest('main')) return false; const next = row.nextElementSibling; const p = next && next.classList.contains('row-error') ? next : document.createElement('p'); p.className = 'row-error'; p.setAttribute('role', 'alert'); p.textContent = text; row.after(p); return true; }
  async function run(fn, button) {
    if (button && button.tagName === 'BUTTON') button.disabled = true;
    try { const r = await fn(); const row = rowOf(button), next = row && row.nextElementSibling; if (next && next.classList.contains('row-error')) next.remove(); return r; }
    catch (e) { const text = String(e.message || e).replace(/^Error invoking remote method '[^']+': Error: /,''); if (!rowError(button, text)) notice(text, true); }
    finally { if (button && button.tagName === 'BUTTON') button.disabled = false; }
  }
  // On a Mac the keys say Command, Control and Option (renderer/mac-words.js loads first).
  const MAC_KEYS = !!(window.NusMacWords && window.NusMacWords.mac);
  const chord = s => MAC_KEYS
    ? String(s || 'Unavailable').replace(/CommandOrControl/g,'Command').replace(/\bCtrl\b/g,'Control').replace(/\bAlt\b/g,'Option')
    : String(s || 'Unavailable').replace(/CommandOrControl|Control/g,'Ctrl').replace(/Return/g,'Enter');
  function paintStatus(s) {
    currentStatus = s;
    if (s.version) $('#app-version').textContent = s.version;
    $('#companion-state').textContent = s.capturing ? 'Listening to a session' : s.running ? 'The Knot is ready' : 'The Knot is off';
    $('#capture-toggle').textContent = s.capturing ? 'Stop listening' : 'Start listening';
    if (s.stats) paintStats(s.stats);
    if (s.update) paintUpdate(s.update);
    if (s.voice) paintVoice(s.voice);
    if (s.speech) paintSpeech(s.speech);
  }
  // The Knot's own voice row: the switch reflects the setting; the note says
  // installed, downloading (with progress), or how big the one-time download is.
  function paintVoice(v) {
    const box = $('#own-voice'), note = $('#own-voice-note'), prog = $('#own-voice-progress');
    if (!box) return;
    box.checked = v.voice !== 'system';
    if (v.downloading) {
      const pct = v.downloading.total ? Math.round(100 * v.downloading.got / v.downloading.total) : 0;
      prog.hidden = false; prog.textContent = 'Downloading the voice… ' + pct + '% (' + Math.round(v.downloading.got / 1048576) + ' of ' + Math.round(v.downloading.total / 1048576) + ' MB)';
      box.disabled = true;
      return;
    }
    box.disabled = false; prog.hidden = true;
    note.textContent = v.installed ? (v.ready ? 'Fable is loaded and speaking.' : 'Fable is installed. It loads the moment you press the talk key.') : 'Fable, a soft British voice that runs on this computer. One download of about ' + Math.round((v.modelBytes || 349906910) / 1048576) + ' MB the first time; nothing leaves your machine. Off, the Windows voice speaks.';
  }
  $('#own-voice').onchange = e => run(async () => {
    const on = e.target.checked;
    if (!on) { await api.settingsSet({ voice: 'system' }); paintVoice(await api.voiceStatus()); notice('Back to the Windows voice.'); return; }
    let v = await api.voiceStatus();
    if (!v.installed) { notice('Downloading Fable. The switch turns on by itself when it is in.'); v = await api.voiceInstall('fable'); }
    if (v.installed) { await api.settingsSet({ voice: 'fable' }); notice('Fable is on.'); }
    paintVoice(await api.voiceStatus());
  });
  api.on('home:voice', v => paintVoice(v));
  // The optional speech model row, the same shape as the voice row above.
  function paintSpeech(v) {
    const box = $('#speech-model'), note = $('#speech-model-note'), prog = $('#speech-model-progress');
    if (!box) return;
    box.checked = v.on;
    if (v.downloading) {
      const pct = v.downloading.total ? Math.round(100 * v.downloading.got / v.downloading.total) : 0;
      prog.hidden = false; prog.textContent = 'Downloading the speech model… ' + pct + '% (' + Math.round(v.downloading.got / 1048576) + ' of ' + Math.round(v.downloading.total / 1048576) + ' MB)';
      box.disabled = true;
      return;
    }
    box.disabled = false; prog.hidden = true;
    const mem = 'It uses about 800 MB of memory while loaded and lets go after ' + v.idleMinutes + ' quiet minutes.';
    note.textContent = !v.installed && v.on ? 'Parakeet by NVIDIA (CC-BY-4.0) writes down what you say: it hears you better than the built-in model. It downloads by itself in the background, once (about ' + Math.round(v.modelBytes / 1048576) + ' MB, about 640 MB on disk); until then the built-in Whisper model does it. ' + mem + ' Nothing leaves your machine. Turn this off to keep Whisper and skip the download.'
      : !v.installed ? 'Parakeet by NVIDIA (CC-BY-4.0), a larger model that runs on this computer and writes down each finished sentence. One download of about ' + Math.round(v.modelBytes / 1048576) + ' MB the first time, about 640 MB on disk. ' + mem + ' Nothing leaves your machine. Off, the built-in Whisper model does it.'
      : !v.on ? 'Parakeet is installed and off. The built-in Whisper model writes down what you say.'
      : v.failed ? 'Parakeet did not load, so the built-in Whisper model is writing down what you say. Turn this off and on to try again.'
      : v.ready ? 'Parakeet is loaded and listening. ' + mem : 'Parakeet is installed. It loads when you press the talk key. ' + mem;
  }
  $('#speech-model').onchange = e => run(async () => {
    const on = e.target.checked;
    if (!on) { await api.settingsSet({ speechModel: 'whisper' }); paintSpeech(await api.speechStatus()); notice('Back to the built-in speech model.'); return; }
    let v = await api.speechStatus();
    if (!v.installed) { notice('Downloading Parakeet. The switch turns on by itself when it is in.'); v = await api.speechInstall(); }
    if (v.installed) { await api.settingsSet({ speechModel: 'parakeet' }); notice('Parakeet is on.'); }
    paintSpeech(await api.speechStatus());
  });
  api.on('home:speech', v => paintSpeech(v));
  // A newer Companion: the card shows once per version until Later or Download.
  let updateUrl = null, updateOneClick = false;
  function paintUpdate(u) {
    const card = $('#update-card');
    const show = !!(u && u.available && !u.dismissed);
    card.hidden = !show;
    if (!show) return;
    updateUrl = u.available.url || null;
    updateOneClick = !!u.oneClick;
    $('#update-title').textContent = 'Nūs Companion ' + u.available.version + ' is out (this is ' + u.current + ').';
    $('#update-download').textContent = updateOneClick ? 'Update' : 'Download';
    const busy = u.progress && (u.progress.phase === 'downloading' || u.progress.phase === 'installing');
    $('#update-download').disabled = !!busy;
    $('#update-copy').textContent = busy ? (u.progress.phase === 'installing' ? 'Checked. Restarting to update.' : 'Downloading: ' + u.progress.pct + '%.')
      : u.progress && u.progress.phase === 'failed' ? 'That did not finish, and nothing changed. The release page has it.'
      : updateOneClick ? 'Nūs restarts in about a minute. Your settings and memory stay.' : 'Download it, quit this one, and run the installer. Your settings and memory stay.';
  }
  $('#update-download').onclick = e => run(async () => { if (updateOneClick) paintUpdate(await api.updateRun()); else if (updateUrl) await api.openExternal(updateUrl); }, e.currentTarget);
  $('#update-later').onclick = e => run(async () => { paintUpdate(await api.updateDismiss()); }, e.currentTarget);
  // The first-run card: the one notice line with its switch, and the one-row
  // "where did you hear" question. One click on the row and the card is gone.
  function paintStats(st) {
    $('#stats-intro').hidden = !st.firstRun;
    $('#send-stats-intro').checked = st.enabled !== false;
    $('#send-stats').checked = st.enabled !== false;
    $('#stats-state').textContent = st.enabled === false ? 'Off. Nothing is sent.' : 'Which features get used, on a random install id. Never your coursework or what you type.';
  }
  // The optional account: the Settings card in one of three states, and the
  // one offer on Saved from the third day the Companion was opened.
  function paintAccount(a) {
    if (!a) return;
    $('#account-out').hidden = a.signedIn || a.signingIn;
    $('#account-pending').hidden = !a.signingIn;
    $('#account-in').hidden = !a.signedIn || a.signingIn;
    $('#account-email').textContent = a.email || 'your Google account';
    $('#account-detail').textContent = a.offline ? 'Offline. Nūs keeps you signed in and catches up when it can reach the server.' : a.secure === false ? 'This computer has no system encryption, so you stay signed in until Nūs quits.' : '';
    $('#account-link').textContent = ({ linked: 'This computer is linked to your account.', stats_off: 'Not linked: anonymous usage stats are off on this computer.', unlinked: 'This computer is not linked.', pending: 'Linking this computer when Nūs can reach the server.' })[a.link] || '';
    $('#account-unlink').hidden = a.link !== 'linked';
    $('#account-plan').textContent = a.signedIn ? (a.isPro ? 'Plan: Pro' + (a.planUntil ? ' until ' + new Date(a.planUntil).toLocaleDateString() : '') : 'Plan: Free. Everything in Nūs works on it.') : '';
    $('#account-sync').checked = !!a.syncOn;
    $('#account-sync-state').textContent = !a.syncOn ? 'Off. Nothing about your settings leaves this computer.' : a.syncOffline ? 'Offline. Changes go up when Nūs can reach the server.' : a.syncLastAt ? 'Last synced ' + new Date(a.syncLastAt).toLocaleString() + '.' : 'Syncing...';
    $('#account-relink').hidden = a.link !== 'unlinked';
    const err = a.error || a.linkError || a.syncError || '';
    $('#account-note').textContent = err;
    $('#account-note').classList.toggle('error', !!err);
    $('#account-offer').hidden = !a.offer;
  }
  const accountSignIn = e => run(async () => { $('#account-offer').hidden = true; paintAccount(await api.accountSignIn()); }, e.currentTarget);
  $('#account-signin').onclick = accountSignIn;
  $('#account-offer-signin').onclick = e => { setView('settings').then(() => $('#account-card').scrollIntoView({ block: 'center' })).catch(() => {}); accountSignIn(e); };
  $('#account-offer-later').onclick = e => run(async () => { paintAccount(await api.accountDismiss()); }, e.currentTarget);
  $('#account-cancel').onclick = e => run(async () => { paintAccount(await api.accountCancel()); }, e.currentTarget);
  $('#account-signout').onclick = e => run(async () => { paintAccount(await api.accountSignOut()); notice('Signed out on this computer.'); }, e.currentTarget);
  $('#account-unlink').onclick = e => run(async () => { paintAccount(await api.accountUnlink()); }, e.currentTarget);
  $('#account-relink').onclick = e => run(async () => { paintAccount(await api.accountLink()); }, e.currentTarget);
  $('#account-delete').onclick = e => run(async () => {
    if (!confirm('Delete your Nūs account? Your synced settings and links are removed from the server. Nūs keeps working on this computer without an account.')) return;
    const a = await api.accountDelete(); paintAccount(a); if (a.deleted) notice('Account deleted. Nūs keeps working here as before.');
  }, e.currentTarget);
  $('#account-sync').onchange = e => run(async () => { paintAccount(await api.accountSync(e.target.checked)); notice(e.target.checked ? 'Settings sync on.' : 'Settings sync off. Nothing more about your settings is sent.'); }, e.target);
  api.on('home:account', a => paintAccount(a));
  // The contact card (companion/src/contact.js): one ask for an email, a few
  // minutes after something worked. The words come from the main process.
  // contactHold: a save is under way or its thank-you is up. The main process
  // pushes the new state (no longer due) before the save call returns, and that
  // push must not hide the card before the thank-you is seen.
  let contactHold = false;
  function paintContact(c) {
    if (!c || !c.words) return;
    if (contactHold) return;
    $('#contact-card').hidden = !c.due;
    $('#contact-title').textContent = c.words.title;
    $('#contact-copy').textContent = c.words.body;
    $('#contact-save').textContent = c.words.button;
    $('#contact-no').textContent = c.words.no;
    $('#contact-email').placeholder = c.words.placeholder;
  }
  $('#contact-form').onsubmit = e => { e.preventDefault(); contactHold = true; run(async () => {
    let r = null;
    try { r = await api.contactGive($('#contact-email').value.trim()); } finally { if (!r || !r.ok) contactHold = false; }
    $('#contact-note').textContent = r.message || '';
    $('#contact-note').classList.toggle('error', !r.ok);
    if (r.ok) { $('#contact-form').hidden = true; setTimeout(() => { contactHold = false; $('#contact-card').hidden = true; }, 6000); }
  }, $('#contact-save')); };
  $('#contact-no').onclick = e => run(async () => { paintContact(await api.contactDecline()); }, e.currentTarget);
  api.on('home:contact', c => paintContact(c));
  async function setView(next) {
    view = next;
    $$('.view').forEach(el => el.classList.toggle('active',el.id==='view-'+next));
    $$('nav button').forEach(el => { el.classList.toggle('active',el.dataset.view===next); if(el.dataset.view===next)el.setAttribute('aria-current','page'); else el.removeAttribute('aria-current'); });
    $('#view-title').textContent=titles[next];
    document.body.classList.toggle('home-view',next==='start');
    document.body.classList.toggle('mynus-view',next==='mynus');
    clearNotice(); toast('');
    // The stats line and "Where did you hear" are one quiet line at the foot of
    // the home view
    // (Apple review fix 9). No other page carries it.
    $('#start-foot').appendChild($('#stats-intro'));
    if(next==='start'){await renderStart();await homeView.refresh();}
    else if(next==='settings')await settings();
    else if(next==='saved')await renderSaved();
    else if(next==='folders')await renderFolders();
    else if(next==='feedback')await renderFeedback();
    else if(next==='mynus')await renderMyNus();
    else await renderMap();
  }
  // My Nus (plan 2026-11-06): numbers about the person, worked out on this
  // computer (companion/src/my-nus.js).
  async function renderMyNus(){
    const s=await api.myNus(); if(!s)return;
    const st=await api.status().catch(()=>({}));
    const name=String((st&&st.name)||'').trim().split(/\s+/)[0];
    $('#n-title').innerHTML=name?'Your week, <em>'+esc(name)+'.</em>':'Your <em>week.</em>';
    const hm=m=>m>=60?Math.floor(m/60)+'h '+(m%60?String(m%60).padStart(2,'0')+'m':''):m+'m';
    const stat=(b,span,small)=>'<div class="n-stat"><b>'+b+'</b><span>'+span+'</span>'+(small?'<small>'+small+'</small>':'')+'</div>';
    $('#n-stats').innerHTML=
      stat(s.thingsDone,'things done for you',!s.thingsDone?'your first is one ask away':s.nextMilestone?(s.nextMilestone-s.thingsDone)+' to your '+s.nextMilestone+'th':'')+
      stat((s.minutesBack?'~':'')+hm(s.minutesBack),'given back','an estimate')+
      stat(s.feedsBlocked,'feeds kept away',s.weekBlocked+' this week')+
      stat(s.streak.days,'workday'+(s.streak.days===1?'':'s')+' in a row',s.streak.forgiven?'1 day forgiven':'weekends never count');
    $('#n-week').innerHTML=s.week.map((d,i)=>'<div class="n-day'+(d.used?' used':'')+(d.today?' today':'')+(d.future?' future':'')+'" style="left:calc(6px + (100% - 12px) * '+i+' / 6)"><i></i><span>'+esc(d.day)+'</span></div>').join('');
    $('#n-uses').innerHTML=s.topUses.length?s.topUses.map(u=>'<li><span>'+esc(u.label)+'</span><span>'+u.count+'</span></li>').join(''):'<li><span class="muted">Ask me anything with the talk key and it shows up here.</span><span></span></li>';
    const open={busiest_hour:s.busiestHour&&('Busiest hour: <b>'+esc(s.busiestHour)+'</b>'),best_day:s.bestDay&&('Best day: <b>'+esc(s.bestDay)+'</b>'),week_compare:s.weekCompare&&('This week <b>'+s.weekCompare.thisWeek+'</b>, last week <b>'+s.weekCompare.lastWeek+'</b>')};
    $('#n-unlocks').innerHTML=s.unlocks.map(u=>'<li><span>'+(u.unlocked&&open[u.key]?open[u.key]:esc(u.label))+'</span><span>'+(u.unlocked?'unlocked':u.daysLeft+' more day'+(u.daysLeft===1?'':'s'))+'</span></li>').join('');
    const k=s.kept||{};
    $('#n-kept').innerHTML=[['Things I remember about you',k.memories],['Projects',k.projects],['Walkthroughs I can replay',k.walkthroughs],['Reminders waiting',k.reminders]].map(([l,n])=>'<li><span>'+l+'</span><span>'+(n||0)+'</span></li>').join('');
    $('#n-share').onclick=()=>run(async()=>{
      if(document.fonts&&document.fonts.ready)await document.fonts.ready;
      const c=window.NusShare.draw(s,name);
      const r=await api.shareCard(c.toDataURL('image/png'));
      $('#n-share-note').hidden=false;
      notice(r&&r.ok?'Copied. Paste it anywhere. A copy is in Pictures, Nūs.':'Could not copy the picture.');
    });
  }
  async function setSaved(next) {
    saved = next;
    $$('.saved-view').forEach(el=>el.classList.toggle('active',el.id==='saved-'+next));
    $$('[data-saved]').forEach(el=>{el.classList.toggle('active',el.dataset.saved===next);el.setAttribute('aria-selected',String(el.dataset.saved===next));});
    await renderSaved();
  }
  async function settings() {
    const [s,status,intents] = await Promise.all([api.settingsGet(),api.status(),api.intents()]);
    paintStatus(status);
    for(const key of ['typesafe','gemini','nvidia','anthropic']) {
      const set=key==='typesafe' ? status.reflex.key : s.keys[key];
      $('#'+key+'-state').textContent=set ? 'Set'+(key==='typesafe'?' · '+status.reflex.keySource:'') : 'Not set';
      $('#'+key+'-state').classList.toggle('set',!!set);
    }
    $('#cli-state').textContent=status.ai.cli?'Found':'Not found';$('#cli-state').classList.toggle('set',!!status.ai.cli);
    $('#claude-status').textContent=status.ai.cli?'Claude Code is installed. If it is signed in, it answers and points with no key.':'Not installed. Not needed if you have a Gemini, Nvidia or Anthropic key.';
    const pub=status.publik||{on:false},viaPublik=!!(pub.on&&pub.choice==='publik');$('#publik-row').hidden=!pub.on;$('#use-own-key').checked=!viaPublik;paintPublikAccount(pub);
    // Voice commands run on the built-in rules with no key (src/reflex/rules.js), so this step is
    // never "Not set". A saved TypeSafe key is named beside it; it is optional.
    const answersOk=!!(viaPublik||s.keys.gemini||s.keys.nvidia||s.keys.anthropic||status.ai.cli);
    $('#step-voice').textContent=status.reflex.key?'Ready · TypeSafe':'Ready';$('#step-voice').classList.add('set');
    $('#typesafe-state').textContent=status.reflex.key?'Set · '+status.reflex.keySource:'Optional';
    $('#step-answers').textContent=answersOk?'Ready'+(viaPublik?' · publik':s.keys.gemini?' · Gemini':s.keys.anthropic?' · Anthropic':s.keys.nvidia?' · Nvidia':' · Claude Code'):'Not set';$('#step-answers').classList.toggle('set',answersOk);
    $('#voice-status').textContent='Whisper engine: '+(status.voice.whisper?'found':'missing')+' · Speech model: '+(status.voice.model?'found':'missing');
    $('#ptt-live').textContent=chord(status.ptt.accelerator);
    $('#ptt-input').placeholder=chord(status.ptt.accelerator);
    $('#open-mic').checked=!!s.openMic;
    fillMics(s);
    $('#persist-transcripts-home').checked=s.persistTranscripts!==false;
    $('#save-audio-home').checked=!!s.saveAudio;
    $('#retention-days').value=s.audioRetentionDays||30;
    $('#knot-display').innerHTML='<option value="">Primary display</option>'+status.displays.map(d=>'<option value="'+d.id+'">'+esc(d.label)+'</option>').join('');
    $('#knot-display').value=s.knotDisplayId??'';
    $('#hide-from-capture').checked=!!status.contentProtection;$('#hide-from-capture').disabled=!!status.captureForcedOff;
    $('#protection-state').textContent=status.captureForcedOff?'Forced off for this launch by the environment.':status.contentProtection?'On. The Knot says "hidden from shares".':'Off. The Knot says "visible in shares".';
    $('#speak-replies-home').checked=!!s.speakReplies;$('#sounds').checked=s.sounds!==false;if($('#draw-on-screen'))$('#draw-on-screen').checked=s.drawOnScreen!==false;$('#channel-messages').checked=s.channelMessages!==false;$('#start-with-windows').checked=s.startWithWindows===true;
    $('#focus-guard').checked=s.focusGuard===true;$('#hands').checked=s.hands===true;if($('#dictation'))$('#dictation').checked=!!(s._dictation&&s._dictation.on);$('#tasks').checked=s.tasks===true;$('#knot-island').checked=s.knotIsland===true;if(document.activeElement!==$('#focus-feeds'))$('#focus-feeds').value=(Array.isArray(s.focusGuardFeeds)?s.focusGuardFeeds:[]).join(', ');
    const spend=status.assignmentSpend;
    // Today's requests from the usage ledger, in front of the assignment-mode cap line.
    const u=status.usage;
    const usageLine=u&&u.requests?'Today: '+u.requests+' model request'+(u.requests===1?'':'s')+(u.failed?' ('+u.failed+' failed)':'')+(u.medianFirstTokenMs!=null?', first word in '+(u.medianFirstTokenMs/1000).toFixed(1)+' s (median)':'')+(u.costUsd?', about $'+u.costUsd.toFixed(2)+' at API prices':'')+'. ':'';
    $('#assignment-spend').textContent=usageLine+(spend&&spend.attempts?'Assignment mode today: '+spend.attempts+' model calls, about $'+spend.usd.toFixed(2)+' of the $'+spend.capUsd+' daily cap on your Anthropic key. Claude Code and Gemini have no cap.':'Assignment mode has a $3 daily cap when it runs on your own Anthropic key. Claude Code and Gemini have no cap.');
    const keys=[['Talk',status.ptt.accelerator],['Select and ask','Ctrl+Shift+T'],['Show or hide','Ctrl+Shift+Space'],['Hide now','Ctrl+Shift+X']];
    $('#hotkeys').innerHTML=keys.map(([label,key])=>'<dt>'+esc(label)+'</dt><dd>'+esc(chord(key))+'</dd>').join('');
    $('#intent-list').innerHTML=Object.entries(intents).filter(([key])=>key!=='none').map(([key,label])=>'<dt>'+esc(key.replaceAll('_',' '))+'</dt><dd>'+esc(label)+'</dd>').join('');
    await renderMemory();
  }
  // What Nūs knows: one row per fact, sources in small print, private ones masked.
  async function renderMemory(panel) {
    const p=panel||await api.memoryPanel();
    const rows=p.facts||[];
    $('#memory-list').innerHTML=rows.length?rows.map(f=>'<div class="item-head memory-row"><p><strong>'+esc(f.label)+'</strong> '+esc(f.value)+(f.sensitive?' <span class="badge">private</span>':'')+'<br><small class="muted">'+esc((f.sources||[]).join(', '))+'</small></p><button data-memory-remove="'+esc(f.id)+'" class="quiet">Forget</button></div>').join(''):'<p class="empty">Nothing saved yet. Add a fact below, or say "remember ..." to the Knot.</p>';
    const imports=Object.entries(p.imports||{});
    $('#memory-forget-source').hidden=!imports.length;
    if(imports.length)$('#memory-forget-source').textContent='Remove imported ('+imports.map(([s,i])=>s+' '+i.added).join(', ')+')';
    await renderRecall();
  }
  // Your notes and AI chats (companion/src/recall): counts, the notes folder, imports.
  const SOURCE_NAMES={claude:'Claude',chatgpt:'ChatGPT',gemini:'Gemini',keep:'Google Keep','apple-notes':'Apple Notes',ai:'other'};
  const when=iso=>iso?new Date(iso).toLocaleString(undefined,{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}):'never';
  const onDay=iso=>iso?new Date(iso).toLocaleDateString(undefined,{month:'long',day:'numeric',year:'numeric'}):'none';
  async function renderRecall(panel) {
    const p=panel||await api.recallPanel();
    const c=p.chats||{}, v=p.vault||{};
    const by=Object.entries(c.bySource||{}).map(([s,n])=>(SOURCE_NAMES[s]||s)+' '+n).join(', ');
    const notes=!p.vaultPath?'Not set':v.building&&!v.indexedAt?'Reading your notes...':v.error?v.error:(v.files||0).toLocaleString()+' notes searchable'+(v.building?' (refreshing)':'');
    const rows=[['Notes folder',p.vaultPath||'None chosen'],['Notes',notes],['Chats imported',(c.conversations||0).toLocaleString()+(by?' ('+by+')':'')],['Messages',(c.messages||0).toLocaleString()],['Newest chat',onDay(c.newestChat)],['Last import',when(c.lastImport)]];
    $('#recall-counts').innerHTML=rows.map(([k,val])=>'<dt>'+esc(k)+'</dt><dd>'+esc(val)+'</dd>').join('');
    $('#recall-vault').textContent=p.vaultPath?'Change notes folder':'Choose notes folder';
    $('#recall-import-folder').disabled=!p.vaultPath;
    $('#recall-forget').hidden=!c.conversations;
    const vec=p.vectors||{};
    if(c.conversations){const line=!vec.available?'Keywords only ('+(vec.reason||'model not installed')+')':vec.embedded>=vec.passages?'On, all '+(vec.passages||0).toLocaleString()+' passages':(vec.running?'Reading ':'Waiting: ')+(vec.embedded||0).toLocaleString()+' of '+(vec.passages||0).toLocaleString()+' passages';$('#recall-counts').insertAdjacentHTML('beforeend','<dt>Search by meaning</dt><dd>'+esc(line)+'</dd>');}
    const w=p.watch||{};
    $('#recall-watch').checked=w.on!==false;
    $('#recall-watch-where').textContent=w.on===false?'Off.':'Watching '+(w.downloads||'Downloads')+(w.folder?' and '+w.folder:'')+'.';
    $('#recall-watch-folder').textContent=w.folder?'Stop watching '+w.folder.split(/[\\/]/).pop():'Also watch a folder';
    return p;
  }
  const imported=r=>r&&r.result?(r.result.conversations?'Imported '+r.result.conversations+' chats, '+r.result.messages+' messages.':'No chats found there. Claude and ChatGPT exports are a conversations.json file (unzip the export first).'):'';
  async function history() {
    const seq=++searchSeq, q=$('#history-search').value.trim();
    let sessions=await api.sessions();
    if(q){const hits=await api.search(q);const ids=new Set(hits.map(h=>h.session_id));sessions=sessions.filter(s=>ids.has(s.id));}
    if(seq!==searchSeq)return;
    // Empty: say what actually starts a conversation (Apple review fix 5), with the live talk key.
    const talk=chord(currentStatus&&currentStatus.ptt&&currentStatus.ptt.accelerator);
    $('#history-sessions').innerHTML=sessions.length?sessions.map(s=>'<button class="history-session'+(selectedSession===s.id?' active':'')+'" data-session="'+s.id+'"><strong>'+esc((s.title||s.first_line||'Session').slice(0,80))+'</strong><small>'+esc(new Date(s.started_at).toLocaleString())+' · '+s.message_count+' lines</small></button>').join(''):(q?'<p class="empty">No matching sessions.</p>':'<div class="empty"><p>Hold '+esc(talk)+' and ask the Knot something. Conversations show up here.</p><button data-show-knot class="quiet">Show the Knot</button></div>');
  }
  async function detail(id) {
    selectedSession=Number(id);await history();
    const [messages,sessions]=await Promise.all([api.messages(selectedSession),api.sessions()]);
    const session=sessions.find(s=>s.id===selectedSession);
    if(!session)return;
    const names={you:'Me',them:'Them',nus:'Nūs'};
    $('#history-detail').innerHTML='<div class="hist-head"><div><h3>'+esc(session.title||'Session')+'</h3><small>'+esc(new Date(session.started_at).toLocaleString())+(session.audio_path?' · Audio retained':'')+'</small></div><button id="export-session">Export</button></div>'+messages.map(m=>'<div class="hist-line"><span class="hist-who">'+esc(names[m.channel]||m.channel)+'</span><span class="hist-time">'+esc(new Date(m.ts).toLocaleTimeString())+'</span><p>'+esc(m.text)+'</p></div>').join('');
  }
  // Reminders and timers the Knot is holding: what, when, and a remove button.
  function paintReminders(rows) {
    $('#reminder-list').innerHTML=rows&&rows.length?rows.map(r=>'<div class="item-head reminder-row"><p><strong>'+esc(r.title)+'</strong><br><small class="muted">'+esc(r.when)+'</small></p><button data-reminder-remove="'+esc(r.id)+'" class="quiet">Remove</button></div>').join(''):'<p class="empty">None set. Say "remind me in 20 minutes to stretch" or "set a timer for 10 minutes".</p>';
  }
  async function renderSaved() {
    paintReminders(await api.reminders());
    if(saved==='history'){await history();return;}
    if(saved==='keeps') {
      const rows=await api.keeps(), groups=new Map();
      for(const row of rows){const name=row.app.process;if(!groups.has(name))groups.set(name,[]);groups.get(name).push(row);}
      $('#saved-keeps').innerHTML=rows.length?[...groups].map(([app,items])=>'<article class="card glass saved-item" data-app="'+esc(app)+'"><h3>'+esc(app)+'</h3>'+items.map(w=>'<div class="item-head"><p>'+esc(w.task)+'<br><small class="muted">'+w.steps+' steps'+(w.stale?' · Needs a fresh walkthrough':'')+'</small></p><button data-forget="'+esc(w.key)+'">Forget</button></div>').join('')+'</article>').join(''):'<p class="empty">Choose Keep after a walkthrough to remember its steps.</p>';
    } else if(saved==='routines') {
      const rows=await api.routines();
      $('#saved-routines').innerHTML=rows.length?rows.map(r=>'<article class="card glass saved-item" data-routine="'+esc(r.savedAt)+'"><div class="item-head"><h3>'+esc(r.name)+'</h3><button data-delete-routine="'+esc(r.savedAt)+'">Delete</button></div><ol>'+r.steps.map(s=>'<li>'+esc(s.label||s.intent.replaceAll('_',' '))+'</li>').join('')+'</ol><p class="muted">Say “run my routine” to replay the latest saved routine.</p></article>').join(''):'<p class="empty">After a sequence of commands, say yes when the Knot offers to save it.</p>';
    } else if(saved==='activity') {
      // What the Knot asked an AI for, newest first: when, what, how it went, how long, which AI, cost.
      const a=await api.activity();
      $('#saved-activity').innerHTML='<p class="activity-today">'+esc(a.today.line)+'</p>'+(a.rows.length?'<div class="activity-scroll"><table class="activity-table"><thead><tr><th>When</th><th>What</th><th>Result</th><th>Took</th><th>AI</th><th>Cost</th><th>Details</th></tr></thead><tbody>'+a.rows.map(r=>'<tr class="'+(r.ok?'':'not-ok')+'"><td>'+esc(r.when)+'</td><td>'+esc(r.feature)+'</td><td>'+esc(r.outcome)+'</td><td>'+esc(r.seconds)+'</td><td>'+esc(r.model)+'</td><td>'+esc(r.cost)+'</td><td class="activity-note">'+esc(r.note)+'</td></tr>').join('')+'</tbody></table></div><p class="muted">The last '+a.rows.length+' requests. Kept only on this computer. Cost is an estimate at API prices; Claude Code on your own plan and free Gemini keys are not charged per request.</p>':'<p class="empty">Nothing yet. Ask the Knot something and it shows up here.</p>');
    } else {
      const rows=await api.notes();$('#saved-notes').innerHTML=rows.length?rows.map(n=>'<p class="card glass note">'+esc(n.replace(/^- /,''))+'</p>').join(''):'<p class="empty">Say “remember that” followed by your note.</p>';
    }
  }
  async function renderFolders() {
    const rows=await api.folders();
    $('#folder-list').innerHTML=rows.length?rows.map(f=>'<article class="card glass folder-card" data-folder="'+esc(f.id)+'"><div class="item-head"><h3>'+esc(f.label)+'</h3><span class="badge '+(f.enabled?'set':'')+'">'+(f.enabled?'Enabled':'Off')+'</span></div><p class="folder-path">'+esc(f.path)+'</p><p class="folder-meta">'+f.files+' files · '+(f.bytes/1024).toLocaleString(undefined,{maximumFractionDigits:0})+' KB · '+(f.indexedAt?'Indexed '+esc(new Date(f.indexedAt).toLocaleString()):'Not indexed')+'</p><div class="folder-actions"><label class="check"><input type="checkbox" data-folder-toggle="'+esc(f.id)+'" '+(f.enabled?'checked':'')+'>Use as context</label><button data-reindex="'+esc(f.id)+'">Reindex</button><button data-remove="'+esc(f.id)+'">Remove</button></div></article>').join(''):'<div class="card glass empty">Your memory starts here.<br>Add a folder of things you want Nūs to know.</div>';
  }
  async function renderMap() {
    const [folders,routines,keeps,sessions,prefs]=await Promise.all([api.folders(),api.routines(),api.keeps(),api.sessions(),api.mapGet()]);
    window.companionMap.render({folders,routines,keeps,sessions,preferences:{companion_map_layout:prefs.layout,companion_map_viewport:prefs.viewport}});
  }
  window.openMapNode=async node=>run(async()=>{
    if(node.type==='core'){await setView('settings');return;}
    if(node.type==='folder'||node.type==='source'){await setView('folders');const item=$$('[data-folder]').find(e=>e.dataset.folder===node.folderId);item?.scrollIntoView({block:'center'});item?.classList.add('highlight');return;}
    await setView('saved');await setSaved(node.type==='session'?'history':node.type==='routine'?'routines':'keeps');
    if(node.sessionId)await detail(node.sessionId);
    else {const item=node.type==='routine'?$$('[data-routine]').find(e=>e.dataset.routine===node.savedAt):$$('[data-app]').find(e=>e.dataset.app===node.app);item?.scrollIntoView({block:'center'});item?.classList.add('highlight');}
  });
  $$('nav button').forEach(b=>b.onclick=()=>run(()=>setView(b.dataset.view)));
  $$('[data-saved]').forEach(b=>b.onclick=()=>run(()=>setSaved(b.dataset.saved)));
  $$('[data-url]').forEach(b=>b.onclick=()=>run(()=>api.openExternal(b.dataset.url)));
  $('#show-knot').onclick=()=>run(()=>api.control('show'));
  $('#tutorial').onclick=()=>run(()=>api.control('tutorial'));
  $('#capture-toggle').onclick=e=>run(async()=>paintStatus(await api.control('capture')),e.currentTarget);
  $('#key-form').onsubmit=e=>{e.preventDefault();run(async()=>{
    const keys={};for(const k of ['typesafe','gemini','nvidia','anthropic']){const input=$('#key-'+k+'-home');if(input.value.trim())keys[k]=input.value.trim();}
    if(Object.keys(keys).length)await api.settingsSet({apiKeys:keys});
    for(const k of ['typesafe','gemini','nvidia','anthropic'])$('#key-'+k+'-home').value='';
    await settings();notice(Object.keys(keys).length?'Keys saved. Checking them now.':'Nothing to save.');
    // A bad key is caught at entry, not on the next ask.
    for(const k of Object.keys(keys))await testKey(k);
  },e.submitter);};
  $$('[data-clear]').forEach(b=>b.onclick=()=>run(async()=>{await api.settingsSet({apiKeys:{[b.dataset.clear]:''}});await settings();notice(b.dataset.clear==='typesafe'?'Saved TypeSafe key cleared. An environment key, if present, still takes priority.':'Saved key cleared.');},b));
  // Test buttons: one round trip per key, the result lands on that row's badge.
  const testLabels={typesafe:'Voice',gemini:'Gemini',nvidia:'Nvidia',anthropic:'Anthropic',cli:'Claude Code'};
  async function testKey(which){
    const badge=$('#'+(which==='cli'?'cli-state':which+'-state'));
    // The note sits directly under the row it is about.
    $('[data-test="'+which+'"]').closest('.key-row').after($('#test-note'));
    badge.textContent='Testing…';badge.classList.remove('ok','bad');$('#test-note').textContent='';
    const r=(await api.keysTest(which))[which];
    badge.textContent=r.ok?'Working · '+r.ms+' ms':r.error==='no key'?'Not set':r.error==='not installed'?'Not found':'Failed';
    badge.classList.toggle('ok',!!r.ok);badge.classList.toggle('bad',!r.ok&&r.error!=='no key'&&r.error!=='not installed');
    // One plain sentence (Apple review fix 4); the provider's own text only behind Details.
    if(!r.ok&&r.error&&r.error!=='no key'&&r.error!=='not installed')$('#test-note').innerHTML=esc(testLabels[which]+': '+(r.message||r.error))+(r.message?'<details><summary>Details</summary><span>'+esc(r.error)+'</span></details>':'');
  }
  // Test on a freshly pasted key saves it first. Before, Test read only the saved
  // key, so a pasted but unsaved one showed "Not set" (feedback 209 and 246).
  async function saveTyped(which){
    const input=$('#key-'+which+'-home');const v=input&&input.value.trim();
    if(!v)return;
    await api.settingsSet({apiKeys:{[which]:v}});input.value='';await settings();
  }
  $$('[data-test]').forEach(b=>b.onclick=()=>run(async()=>{await saveTyped(b.dataset.test);await testKey(b.dataset.test);},b));
  // -------- Get started: the tour (companion/src/tour.js, run by the Knot) --------
  // One card. The tour itself runs on the overlay, over the person's screen.
  function paintStartNav(st){$('#tour-card').hidden=!(st&&(st.show||st.running));}
  function paintTour(st){paintStartNav(st);$('#tour-state').textContent=st.running?'The tour is running on your screen, step '+st.step+' of '+(st.of||11)+'.':st.done?'Tour done. Quick tour in the corner starts it again.':'';$('#tour-start').textContent=st.running?'Show the tour':st.done?'Take it again':'Start the tour';$('#tour-skip').hidden=!!(st.done||st.running);}
  async function renderStart(){paintTour(await api.tourState());}
  $('#tour-start').onclick=e=>run(async()=>{paintTour(await api.tourStart());},e.currentTarget);
  $('#tour-skip').onclick=e=>run(async()=>{paintTour(await api.tourSkip());await setView('start');},e.currentTarget);
  api.on('home:tour',st=>{paintTour(st);});
  api.on('home:view',p=>run(async()=>{await setView(p&&(p.view==='settings'||p.view==='feedback'||p.view==='mynus')?p.view:view);if(p&&p.view==='feedback')$('#feedback-message').focus();const target=p&&p.section==='keys'?$('#keys-card'):null;if(target)target.scrollIntoView({block:'start',behavior:'smooth'});}));
  // Feedback page: a kind, the person's words, an optional reply address.
  // Sent now, or kept on this computer and sent when Nūs can reach the server.
  let feedbackKind='other';
  function feedbackNote(text,cls){const n=$('#feedback-note');n.textContent=text||'';n.className='muted'+(cls?' '+cls:'');}
  async function renderFeedback(){const st=await api.feedbackStatus();feedbackNote(st&&st.waiting?(st.waiting===1?'1 note is':st.waiting+' notes are')+' waiting to send. They go as soon as Nūs can reach the server.':'');}
  $('#feedback-form .source-row').onclick=e=>{const b=e.target.closest('[data-kind]');if(!b)return;feedbackKind=b.dataset.kind;$$('#feedback-form [data-kind]').forEach(x=>{const on=x===b;x.classList.toggle('on',on);x.setAttribute('aria-checked',String(on));});};
  $('#feedback-form').onsubmit=e=>{e.preventDefault();const message=$('#feedback-message').value.trim();if(!message){feedbackNote('Write a line first.','error');$('#feedback-message').focus();return;}
    run(async()=>{feedbackNote('Sending...');const r=await api.feedbackSend({kind:feedbackKind,message,email:$('#feedback-email').value.trim()});
      $('#feedback-message').value='';
      feedbackNote(r&&r.delivered?'Sent. Thank you. Pranav reads every note.':'Saved on this computer. It goes to Pranav as soon as Nūs can reach him.','ok');},e.submitter);};
  $('#ptt-form').onsubmit=e=>{e.preventDefault();run(async()=>{const r=await api.setPtt($('#ptt-input').value);if(!r.ok)throw new Error(r.error||'No talk key could be registered.');await settings();notice(r.fallback?'Requested key was unavailable. Live key: '+chord(r.accelerator):'Talk key updated.');},e.submitter);};
  // Settings, Voice, Microphone (companion/renderer/mic-devices.js, the same list the Knot reads).
  // Picking one saves it; the Knot's open mic moves to it. Test opens it for a few seconds and
  // shows the level, so a silent one is plain before the first ask.
  const NM=window.NusMic;let micSaved={micDeviceId:'',micDeviceLabel:''},micTest=null;
  async function fillMics(s){
    if(s)micSaved={micDeviceId:s.micDeviceId||'',micDeviceLabel:s.micDeviceLabel||''};
    const sel=$('#mic-select');if(!sel||!NM)return;
    let found={list:[],defaultLabel:''};try{found=NM.inputs(await navigator.mediaDevices.enumerateDevices());}catch(_){}
    const pick=NM.choose(found,micSaved);
    const rows=[{id:'',label:'Windows default'+(found.defaultLabel?' ('+found.defaultLabel+')':'')}].concat(found.list);
    if(pick.why==='missing')rows.push({id:micSaved.micDeviceId,label:(micSaved.micDeviceLabel||'Your microphone')+' (not plugged in)'});
    sel.innerHTML=rows.map(d=>'<option value="'+esc(d.id)+'">'+esc(d.label)+'</option>').join('');
    sel.value=pick.why==='missing'?micSaved.micDeviceId:pick.id;
    if(!micTest)$('#mic-note').textContent=!found.list.length?'No microphone found. Plug one in, or type to the Knot: click it and type.':pick.why==='missing'?'That one is not plugged in. The Windows default listens until it is back.':'The Knot listens with this one. Plug in a new one and it shows up here.';
  }
  if($('#mic-select'))$('#mic-select').onchange=e=>run(async()=>{
    const opt=e.target.selectedOptions[0],id=e.target.value,label=id&&opt?opt.textContent.replace(/ \(not plugged in\)$/,''):'';
    micSaved={micDeviceId:id,micDeviceLabel:label};await api.settingsSet(micSaved);notice('Saved. The Knot listens with '+(id?label:'the Windows default')+'.');
    if(micTest)stopMicTest();
  },e.target);
  function stopMicTest(){if(!micTest)return;clearInterval(micTest.timer);clearTimeout(micTest.end);try{micTest.stream.getTracks().forEach(t=>t.stop());micTest.ctx.close();}catch(_){}micTest=null;$('#mic-meter').hidden=true;$('#mic-test').textContent='Test';}
  if($('#mic-test'))$('#mic-test').onclick=async()=>{
    if(micTest){stopMicTest();return;}
    const sel=$('#mic-select'),id=sel.value,name=sel.selectedOptions[0]?sel.selectedOptions[0].textContent:'this microphone';
    try{
      const stream=await navigator.mediaDevices.getUserMedia(NM.constraints(id)),ctx=new AudioContext(),an=ctx.createAnalyser();an.fftSize=1024;ctx.createMediaStreamSource(stream).connect(an);
      const buf=new Float32Array(an.fftSize),bar=$('#mic-meter i');let peak=0,heard=0;const at=Date.now();
      micTest={stream,ctx,timer:setInterval(()=>{an.getFloatTimeDomainData(buf);let sum=0;for(const v of buf)sum+=v*v;const rms=Math.sqrt(sum/buf.length);peak=Math.max(peak,rms);if(rms*7>.22)heard+=60;bar.style.width=Math.min(100,Math.round(rms*700))+'%';},60),end:null};
      $('#mic-meter').hidden=false;$('#mic-test').textContent='Stop';$('#mic-note').textContent='Say something. The bar should move.';
      micTest.end=setTimeout(()=>{const kind=heard>=500?'':NM.verdict(Date.now()-at,false,peak);stopMicTest();$('#mic-note').textContent=kind?NM.helpLine(kind,name,sel.options.length>2):'It hears you. '+name+' works.';fillMics();},6000);
    }catch(err){$('#mic-note').textContent=NM.failLine(err&&err.name);}
  };
  if(navigator.mediaDevices&&navigator.mediaDevices.addEventListener)navigator.mediaDevices.addEventListener('devicechange',()=>{setTimeout(()=>fillMics(),400);});
  // Which publik account this is, and the way out. Sign out is two taps: the first says what happens.
  let publikWhoAt=0;
  function paintPublikAccount(pub){
    $('#publik-account').hidden=!pub.on;
    if(!pub.on||!api.publikWho||Date.now()-publikWhoAt<60000)return;
    publikWhoAt=Date.now();
    api.publikWho().then(w=>{$('#publik-who').textContent=w&&w.handle?'Signed in with publik as '+w.handle+'.':w&&w.claimed===false?'Not signed in to publik yet.':'Signed in with publik.';}).catch(()=>{});
  }
  function publikSignOutArmed(v){$('#publik-signout-hint').hidden=!v;$('#publik-signout-cancel').hidden=!v;$('#publik-signout').textContent=v?'Sign out and restart Nūs':'Sign out of publik';$('#publik-signout').dataset.armed=v?'1':'';}
  $('#publik-signout-cancel').onclick=()=>publikSignOutArmed(false);
  $('#publik-signout').onclick=e=>{
    if(e.currentTarget.dataset.armed!=='1'){publikSignOutArmed(true);return;}
    run(async()=>{const r=await api.publikSignOut();if(r&&r.ok)notice('Signed out of publik. Nūs is restarting.');else{publikSignOutArmed(false);notice('Could not sign out of publik on this computer.',true);}},e.currentTarget);
  };
  $('#use-own-key').onchange=e=>run(async()=>{await api.publikChoice(e.target.checked?'own_key':'publik');await settings();notice(e.target.checked?'Saved. Your own key or Claude Code answers now.':'Saved. publik answers now.');},e.target);
  const fields={'open-mic':['openMic',e=>e.checked],'speak-replies-home':['speakReplies',e=>e.checked],'sounds':['sounds',e=>e.checked],'draw-on-screen':['drawOnScreen',e=>e.checked],'channel-messages':['channelMessages',e=>e.checked],'start-with-windows':['startWithWindows',e=>e.checked],'focus-guard':['focusGuard',e=>e.checked],'hands':['hands',e=>e.checked],'dictation':['dictation',e=>e.checked],'tasks':['tasks',e=>e.checked],'knot-island':['knotIsland',e=>e.checked],'focus-feeds':['focusGuardFeeds',e=>e.value.split(',').map(x=>x.trim()).filter(Boolean)],'hide-from-capture':['hideFromCapture',e=>e.checked],'persist-transcripts-home':['persistTranscripts',e=>e.checked],'save-audio-home':['saveAudio',e=>e.checked],'retention-days':['audioRetentionDays',e=>Number(e.value)],'knot-display':['knotDisplayId',e=>e.value?Number(e.value):null]};
  for(const [id,[key,value]] of Object.entries(fields))$('#'+id).onchange=e=>run(async()=>{await api.settingsSet({[key]:value(e.target)});notice('Saved.');},e.target);
  // Two switches, one setting: the first-run card and the Privacy card stay in step.
  for(const id of ['send-stats','send-stats-intro'])$('#'+id).onchange=e=>run(async()=>{await api.settingsSet({sendStats:e.target.checked});paintStatus(await api.status());notice(e.target.checked?'Anonymous usage stats on.':'Anonymous usage stats off. Nothing more is sent.');});
  $('#stats-intro').onclick=e=>{const b=e.target.closest('[data-source]');if(b)run(async()=>{paintStats(await api.statsSource(b.dataset.source));},b);};
  $('#knot-move').onchange=e=>run(async()=>{const corner=e.target.value;e.target.value='';if(corner){await api.control('move-'+corner);notice('The Knot is on its way.');}});
  let searchTimer;$('#history-search').oninput=()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>run(history),220);};
  $('#history-sessions').onclick=e=>{if(e.target.closest('[data-show-knot]')){run(()=>api.control('show'));return;}const b=e.target.closest('[data-session]');if(b)run(()=>detail(b.dataset.session));};
  $('#history-detail').onclick=e=>{const b=e.target.closest('#export-session');if(b)run(async()=>{const r=await api.exportSession(selectedSession);if(r.ok)notice('Exported to '+r.path);},b);};
  $('#saved-keeps').onclick=e=>{const b=e.target.closest('[data-forget]');if(b)run(async()=>{await api.forgetKeep(b.dataset.forget);await renderSaved();},b);};
  $('#reminder-list').onclick=e=>{const b=e.target.closest('[data-reminder-remove]');if(b)run(async()=>{paintReminders(await api.removeReminder(b.dataset.reminderRemove));notice('Reminder removed.');},b);};
  api.on('home:reminders',rows=>paintReminders(rows));
  $('#saved-routines').onclick=e=>{const b=e.target.closest('[data-delete-routine]');if(b)run(async()=>{await api.deleteRoutine(b.dataset.deleteRoutine);await renderSaved();},b);};
  // What Nūs knows: add, forget one, copy the import prompt, import a paste, drop an import.
  $('#memory-add').onsubmit=e=>{e.preventDefault();run(async()=>{const v=$('#memory-value').value.trim();if(!v)return;await renderMemory(await api.memoryAdd($('#memory-key').value,v));$('#memory-value').value='';$('#memory-note').textContent='Saved.';},e.submitter);};
  $('#memory-list').onclick=e=>{const b=e.target.closest('[data-memory-remove]');if(b)run(async()=>{await renderMemory(await api.memoryRemove(b.dataset.memoryRemove));$('#memory-note').textContent='Forgotten.';},b);};
  $('#memory-prompt').onclick=e=>run(async()=>{await api.memoryPrompt();$('#memory-note').textContent='Prompt copied. Paste it into your assistant, then paste its answer above.';},e.currentTarget);
  $('#memory-import').onclick=e=>run(async()=>{const text=$('#memory-paste').value.trim();if(!text){$('#memory-note').textContent='Paste the answer first.';return;}const p=await api.memoryImport($('#memory-source').value,text);await renderMemory(p);$('#memory-paste').value='';const i=p.imports&&p.imports[$('#memory-source').value];$('#memory-note').textContent=i?'Imported '+i.added+' of '+i.count+' facts.':'Imported.';},e.currentTarget);
  $('#recall-vault').onclick=e=>run(async()=>{const p=await api.recallVault();if(p&&p.canceled)return;await renderRecall(p);$('#recall-note').textContent='Notes folder set. Reading it in the background.';},e.currentTarget);
  $('#recall-import-folder').onclick=e=>run(async()=>{$('#recall-note').textContent='Importing...';const p=await api.recallImportFolder();await renderRecall(p);$('#recall-note').textContent=imported(p);},e.currentTarget);
  $('#recall-import-file').onclick=e=>run(async()=>{const p=await api.recallImportFile();if(p&&p.canceled)return;await renderRecall(p);$('#recall-note').textContent=imported(p);},e.currentTarget);
  $('#tasks-delete').onclick=e=>run(async()=>{const note=$('#tasks-delete-note');note.hidden=true;if(!confirm('Delete all tasks and projects? A running task stops first. Every request, project and the Hands log are removed from this computer. This cannot be undone.'))return;await api.tasksDelete();note.textContent='Tasks and projects deleted.';note.hidden=false;},e.currentTarget);
  $('#recall-forget').onclick=e=>run(async()=>{if(!confirm('Forget all imported chats? They are removed from this computer. Your notes folder and the facts above stay.'))return;const p=await api.recallForget();await renderRecall(p);$('#recall-note').textContent='Forgot '+p.result.removed+' imported chats.';},e.currentTarget);
  api.on('home:recall',p=>{renderRecall(p).catch(()=>{});});
  $('#recall-watch').onchange=e=>run(async()=>{await renderRecall(await api.recallWatch(e.currentTarget.checked));});
  $('#recall-watch-folder').onclick=e=>run(async()=>{const cur=(await api.recallPanel()).watch||{};const p=await api.recallWatchFolder(Boolean(cur.folder));if(p&&p.canceled)return;await renderRecall(p);},e.currentTarget);
  // Topics (beta): a nested list, one group per topic, chats inside. One-off chats share a group at the end.
  const month=d=>d?new Date(d+'T12:00:00').toLocaleDateString(undefined,{month:'short',year:'numeric'}):'';
  async function renderTopics(){
    const m=await api.recallTopics();
    const topics=m.topics||[];
    $('#topics-method').textContent=topics.length?(m.method==='meaning'?'Grouped by meaning.':'Grouped by keywords for now.'):'';
    if(!topics.length){$('#topics-list').innerHTML='<p class="empty">Import some chats first.</p>';return;}
    const groups=topics.filter(t=>t.count>1), single=topics.filter(t=>t.count===1);
    if(single.length)groups.push({label:'One chat each',count:single.length,from:single.map(t=>t.from).sort()[0],to:single.map(t=>t.to).sort().pop(),conversations:single.flatMap(t=>t.conversations).sort((a,b)=>b.date.localeCompare(a.date))});
    const span=t=>t.from&&t.to?(month(t.from)===month(t.to)?month(t.to):month(t.from)+' to '+month(t.to)):'';
    $('#topics-list').innerHTML=groups.map(t=>'<details class="topic"><summary><strong>'+esc(t.label)+'</strong> <span class="muted">'+t.count+' chat'+(t.count===1?'':'s')+(span(t)?', '+esc(span(t)):'')+'</span></summary><ul>'+t.conversations.map(c=>'<li>'+esc(c.title)+' <small class="muted">'+esc(c.date||'')+(c.source?', '+esc(SOURCE_NAMES[c.source]||c.source):'')+'</small></li>').join('')+'</ul></details>').join('');
  }
  $('#topics-refresh').onclick=e=>run(renderTopics,e.currentTarget);
  $('#memory-forget-source').onclick=e=>run(async()=>{await renderMemory(await api.memoryForgetSource($('#memory-source').value));$('#memory-note').textContent='Imported facts from '+$('#memory-source').value+' removed.';},e.currentTarget);
  $('#add-folder').onclick=e=>run(async()=>{await api.addFolder();await renderFolders();},e.currentTarget);
  $('#folder-list').onclick=e=>{const b=e.target.closest('[data-reindex],[data-remove]');if(b)run(async()=>{if(b.dataset.reindex)await api.reindexFolder(b.dataset.reindex);else await api.removeFolder(b.dataset.remove);await renderFolders();},b);};
  $('#folder-list').onchange=e=>{const b=e.target.closest('[data-folder-toggle]');if(b)run(async()=>{await api.toggleFolder(b.dataset.folderToggle,b.checked);await renderFolders();});};
  api.on('home:indexing',s=>{$('#indexing-status').textContent=s.message;$('#add-folder').disabled=!s.done;});
  api.on('home:save-state',s=>{if(s.ok===false)notice(s.message||'Your latest changes could not be saved.',true);});
  api.on('home:state',s=>{paintStatus(s);homeView.onStatus(s);if(view==='settings'&&s.ptt)$('#ptt-live').textContent=chord(s.ptt.accelerator);});
  // The live home view (now.js): the same state as the pill, and the mirror's way in.
  const homeView=window.NusDashHome.create({doc:document,api,panel:window.NusTaskPanel,options:window.NusQuickOptions,
    knot:()=>{if(window.NusKnotEngine)window.NusKnotEngine.mount({body:$('#d-knot'),thread:null,light:{treatment:'none'},pauseWhenHidden:true});},
    openSaved:()=>run(()=>setView('saved')),
    openSession:id=>run(async()=>{await setView('saved');await setSaved('history');await detail(id);}),
    // The voice switch on the home row sends a not-yet-installed Fable here. The scroll waits two frames for
    // Settings to lay out: scrolled at once it did nothing and left the person on Keys, the top card (a tester, 2026-11-15).
    openSettings:section=>run(async()=>{await setView('settings');if(section==='voice'){await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));const box=$('#own-voice');if(box){box.closest('.card').scrollIntoView({block:'start'});box.focus({preventScroll:true});notice('Fable needs one download first. Turn on the Knot voice switch here.');}}}),
    onError:e=>notice(e.message||String(e),true)});
  // A switch flipped anywhere: the home row and the Settings page both follow.
  function mirrorSettings(s){homeView.onSettings(s);if(view!=='settings')return;for(const [id,on] of [['open-mic',!!s.openMic],['sounds',s.sounds!==false],['draw-on-screen',s.drawOnScreen!==false],['channel-messages',s.channelMessages!==false],['start-with-windows',s.startWithWindows===true],['hands',s.hands===true],['tasks',s.tasks===true],['knot-island',s.knotIsland===true],['hide-from-capture',s.hideFromCapture!==false],['speak-replies-home',!!s.speakReplies]]){const box=$('#'+id);if(box&&box!==document.activeElement)box.checked=on;}}
  api.on('home:settings',mirrorSettings);
  api.on('home:update',paintUpdate);
  api.on('home:tasks',p=>homeView.onTask(p));
  api.on('home:knot',w=>homeView.onKnot(w));
  api.on('home:voice',v=>homeView.onVoice(v));
  window.addEventListener('focus',()=>run(async()=>{paintStatus(await api.status());paintAccount(await api.accountStatus());paintContact(await api.contactStatus());if(view==='saved')await renderSaved();if(view==='settings')await settings();if(view==='start'){await renderStart();await homeView.refresh();}}));
  // The mark in the rail is the Knot itself: the overlay's engine, body only, at
  // rest. The canvas is 116 px because that is the frame the engine draws. It
  // stops drawing while this window is hidden or in the background.
  const mark=window.NusKnotEngine&&window.NusKnotEngine.mount({body:$('#brand-knot'),thread:null,light:{treatment:'none'},pauseWhenHidden:true});
  if(mark){window.addEventListener('blur',()=>mark.knot.pause());window.addEventListener('focus',()=>mark.knot.resume());}
  run(async()=>{paintStatus(await api.status());paintAccount(await api.accountStatus());paintContact(await api.contactStatus());const st=await api.tourState();paintTour(st);await setView('start');});
})();
