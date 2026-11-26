const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = p => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const main = read('companion/index.js');
const ui = read('companion/renderer/renderer.js');
const desktop = read('renderer/app.js');

test('interrupting a long spoken answer clears the echo gate and takes desktop microphone ownership', () => {
  const body = main.slice(main.indexOf('function pttStart()'), main.indexOf('async function pttStop('));
  let takeovers = 0, resets = 0; const sent = [];
  const ctx = { win: { isDestroyed: () => false, isVisible: () => true }, OPEN_MIC: true, ptt: { held: false }, state: {}, guide: null,
    speakMuteUntil: Date.now() + 60000, hooks: { onVoiceTakeover: () => takeovers++ },
    getReflex: () => ({ enabled: () => true, warm() {} }), getListener: () => ({ available: true, reset() { resets++; } }), warmGuideBrain() {},
    send: (c,p) => sent.push([c,p]), probeReady: () => false, setTimeout: () => 1, OPEN_MIC_MAX_MS: 180000, Date, speechTurn: 4, startMacReleaseWatch() {} };
  vm.runInNewContext(body + ';pttStart();', ctx);
  assert.equal(ctx.speakMuteUntil, 0); assert.equal(ctx.ptt.held, true);
  assert.equal(takeovers, 1); assert.equal(resets, 1);
  assert.ok(sent.some(([c,p]) => c === 'ptt:state' && p.held));
  assert.equal(ctx.speechTurn, 5, 'the key going down starts a new speech turn: the old reply says no more');
});

test('main mute blocks speech from every channel without hiding the visible answer', () => {
  const body = main.slice(main.indexOf('let speakMuteUntil ='), main.indexOf('// What the Companion knows'));
  const sent = []; let stops = 0;
  const ctx = { hooks: { onVoiceTakeover: () => stops++ }, ptt: { held: false }, listener: null,
    win: { isDestroyed: () => false, webContents: { send: (c,p) => sent.push([c,p]) } }, Date, IS_MAC: false };
  vm.runInNewContext(body + ';send("assignment:voice",{enabled:false});send("guide:bubble",{text:"visible",speak:"late reply"});', ctx);
  assert.equal(stops, 1); assert.equal(sent.at(-1)[1].speak, undefined); assert.equal(sent.at(-1)[1].text, 'visible');
  vm.runInNewContext('send("assignment:voice",{enabled:true});send("guide:bubble",{speak:"requested"});', ctx);
  assert.equal(sent.at(-1)[1].speak, 'requested');
  ctx.ptt.held = true;
  vm.runInNewContext('send("guide:hint",{speak:"interrupting"});', ctx);
  assert.equal(sent.at(-1)[1].speak, undefined);
});

test('renderer blocks late general and guide speech after mute, and speech during listening', () => {
  const body = ui.slice(ui.indexOf('  let companionVoiceEnabled ='), ui.indexOf('  async function runMode('));
  const handler = ui.match(/nus\.on\('assignment:voice', p => \{[\s\S]*?\n  \}\);/)[0];
  let update; const spoken = []; let cancels = 0;
  const ctx = { settings: { speakReplies: true }, pttHeld: false, voice: null, plainify: t => t,
    SpeechSynthesisUtterance: function(t) { this.text = t; }, speechSynthesis: { cancel() { cancels++; }, speak: u => spoken.push(u.text) },
    nus: { on: (_, cb) => { update = cb; } } };
  vm.runInNewContext(body + handler, ctx);
  update({enabled:false}); vm.runInNewContext('speak("bye");say("queued guide");', ctx);
  assert.deepEqual(spoken, []); assert.ok(cancels);
  update({enabled:true}); vm.runInNewContext('say("requested answer");', ctx);
  assert.deepEqual(spoken, ['requested answer']);
  ctx.pttHeld = true; vm.runInNewContext('speak("late general");say("late guide");', ctx);
  assert.equal(spoken.length, 1);
});

test('desktop takeover stops its separate conversation and drops late streamed replies', () => {
  const stop = desktop.slice(desktop.indexOf('function stopVoice(){'), desktop.indexOf('function toggleVoice(){'));
  const event = desktop.slice(desktop.indexOf('api.onAiEvent?.('), desktop.indexOf('// -- start / stop / setup --'));
  const takeover = desktop.match(/api\.onCompanionVoiceTakeover\?\.\([^\n]+/)[0];
  let aiEvent, take; let canceled=0, micStopped=0;
  const element = { classList: {add(){},remove(){}} };
  const ctx = { voiceOn:true, voicePendingAsk:true, voiceNusLine:{}, voiceProposal:{}, voiceStartGeneration:0, speechSynthesis:{cancel(){canceled++;}},
    api:{voiceCancel:()=>Promise.resolve(),onAiEvent:cb=>{aiEvent=cb;},onCompanionVoiceTakeover:cb=>{take=cb;}},
    stopVoiceMic(){micStopped++;}, heroKnot3d:null, $:()=>element, setVoiceState:s=>{ctx.voiceState=s;},
    vadChunks:[],vadPre:[],vadPreSamples:0,vadSpeaking:true,vadHot:1 };
  vm.runInNewContext(stop + event + takeover, ctx);
  take(); aiEvent({type:'done',text:'Bye!'});
  assert.equal(ctx.voiceOn,false); assert.equal(ctx.voicePendingAsk,false); assert.equal(ctx.voiceState,'off');
  assert.equal(canceled,1); assert.equal(micStopped,1); assert.equal(ctx.voiceStartGeneration,1);
});

test('desktop microphone opening cannot reactivate chat after a takeover', async () => {
  const begin = desktop.slice(desktop.indexOf('let voiceStartGeneration='), desktop.indexOf('async function startVoice(){'));
  let resolve, stopped=0;
  const ctx = { startVoiceMic:()=>new Promise(r=>{resolve=r;}),stopVoiceMic:()=>stopped++, voiceOn:false };
  vm.runInNewContext(begin + ';pending=beginListening();',ctx);
  vm.runInNewContext('voiceStartGeneration++;',ctx); resolve(); await ctx.pending;
  assert.equal(ctx.voiceOn,false); assert.equal(stopped,1);
});

test('background speech rejection keeps an actually open microphone visibly listening', () => {
  const body = main.slice(main.indexOf('function restoreKnotStateAfterAssignment()'), main.indexOf('// An ask that belongs'));
  const sent=[];
  vm.runInNewContext(body+';restoreKnotStateAfterAssignment();',{ptt:{held:true},assignment:{showing:()=>false},send:(c,p)=>sent.push(p)});
  assert.equal(sent[0].state,'listening');
});
