const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createAssignmentRouter, obvious } = require('../src/guide/assignment-router');
const { Assignment } = require('../src/guide/assignment');

test('style commands and Whisper garble never request a solve', async () => {
  const route = createAssignmentRouter({ client: { ready() { throw new Error('local command must not use Jev'); } } });
  for (const t of ['walkthrough mode off', 'just give me the answers', 'answers only', 'answer mode', 'walk through mode of just give me the answers']) assert.equal((await route(t, { on: true })).intent, 'answers_only');
  assert.equal(obvious('walkthrough mode on', true), 'walkthrough_on');
  assert.equal(obvious('walk me through it', true), 'walkthrough_on');
  assert.equal(obvious('turn on assignment mode for this assignment', false), 'mode_on');
  assert.equal(obvious('a sign meant mode', false), 'mode_on');
  assert.equal((await route('voice mode off', { on: true })).intent, 'voice_off');
  assert.equal((await route('voice mode on', { on: true })).intent, 'voice_on');
  assert.equal((await route('OK, solve this.', { on: false })).intent, 'mode_on');
  assert.equal((await route('okay solve this', { on: true })).intent, 'question_about_problem');
  assert.equal((await route('Solve this one too.', { on: true })).intent, 'question_about_problem');
  assert.equal(obvious('I could solve this manually',false),null);
});

test('voice off keeps assignment active and mutes future voice answers without a solve', () => {
  const sent = [], a = new Assignment({ send: (c,p) => sent.push([c,p]), solve: () => { throw new Error('no model'); } });
  a.on = true; a.view = { answer:'42', problem:'Q2', steps:[], index:0, voice:true };
  a.setVoice(false); a.setStyle('answers','voice');
  assert.equal(a.on,true); assert.equal(sent.at(-1)[1].text,'42'); assert.equal(sent.at(-1)[1].speak,undefined);
  assert.ok(sent.some(([c,p]) => c === 'assignment:voice' && !p.enabled));
  a.setVoice(true); assert.equal(sent.at(-1)[1].speak,'42','voice on immediately resumes the current answer');
});

test('a narration mentioning solve before activation still requires addressed classification', async () => {
  let calls=0;
  const route=createAssignmentRouter({ client:{ready:()=>true, systemOne:async()=>{calls++;return {answers:{intent:{choice:'not_for_me',confidence:0.95},addressed:{noul:0.1}}};}} });
  const r=await route('Promise, you could solve this manually. Hold on, let me try some.',{on:false,source:'voice'});
  assert.equal(r.intent,'not_for_me'); assert.equal(calls,1);
});
test('one Jev decision requires both a confident problem question and addressed speech', async () => {
  let calls = 0, confidence = 0.61, addressed = 0.7;
  const route = createAssignmentRouter({ client: { ready: () => true, async systemOne(r) { calls++; assert.equal(Object.keys(r.questions).length, 2); return { ms: 17, answers: { intent: { choice: 'question_about_problem', confidence }, addressed: { noul: addressed } } }; } } });
  assert.equal((await route('why divide by two', { on: true })).intent, 'question_about_problem');
  confidence = 0.59;
  assert.equal((await route('why divide by two', { on: true })).intent, 'not_for_me');
  confidence = 0.8; addressed = 0.2;
  assert.equal((await route('why divide by two', { on: true })).intent, 'not_for_me');
  assert.equal(calls, 3);
});
test('style switches reuse the current result without calling a model', () => {
  const sent = [];
  const a = new Assignment({ send: (c, p) => sent.push([c, p]), solve: () => { throw new Error('no model'); } });
  a.view = { answer: '42', problem: 'Question 2', steps: [{ title: 'One', body: 'Reason' }], index: 0 };
  a.setStyle('answers', 'voice');
  assert.equal(sent.at(-1)[1].text, '42'); assert.equal(sent.at(-1)[1].speak, '42');
  a.setStyle('answers', 'typed'); assert.equal(sent.at(-1)[1].speak, undefined);
  a.setStyle('walkthrough', 'typed'); assert.equal(sent.at(-1)[1].text, 'Reason\n\nAnswer: 42');
});
