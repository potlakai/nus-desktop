const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Assignment } = require('../src/guide/assignment');
const { createWarm, cacheSimilarity } = require('../src/guide/assignment-watch');
const { imageRect, maskBitmap } = require('../src/guide/assignment-capture');
const tick = () => new Promise(r => setImmediate(r));
const text = 'Homework Question 16 Evaluate the integral of 3 x squared and enter your answer';
const fast = '{"found":true,"problem":"Question 16","answer":"x^3 + C","confidence":0.9}';
const check = JSON.stringify({ found: true, problem: 'Question 16', steps: [{ title: 'Integrate', body: 'Raise the power and divide.' }], answer: 'x^3 + C', confidence: 0.9, check: 'Derivative is 3 x squared.' });
function rig(over = {}) {
  const w = { calls: [], text, records: [], sent: [], captures: [], gate: { verdict: 'different', choice: 'different', confidence: 0.9, homeworkPage: 0.9, ms: 123 } };
  const a = new Assignment({ now: Date.now, foreground: async () => ({ hwnd: 1, process: 'firefox', title: 'assignment' }), capture: async opts => { w.captures.push(opts); return { dataUrl: opts?.model ? 'data:image/jpeg;base64,AA' : null, jpeg: Buffer.from('x'), blockMs: 2 }; }, ocr: async () => w.text, judge: async () => w.gate, frame: async () => ({ cells: new Uint8Array(1296) }), send: (c,p) => w.sent.push([c,p]), record: r => w.records.push(r), fastModel: 'haiku', hedgeAfterMs: 0, solveLane: async p => { w.calls.push(p.lane); const raw = p.lane === 'fast' ? fast : check; p.onToken(raw); return { text: raw }; }, ...over });
  a.on = true;
  return { a, w };
}
test('production gate rejects a non-homework screen without starting either lane', async () => {
  const { a,w } = rig(); w.gate.homeworkPage = 0.1;
  await a.look({ settled:true }); await tick();
  assert.deepEqual(w.calls, []);
  assert.equal(w.captures.every(o => o.model === false), true);
  for (const choice of ['same', 'none']) {
    const r = rig(); r.w.gate = { verdict:'unsure', choice, confidence:0.55, homeworkPage:0.8, ms:20 };
    await r.a.look({settled:true}); await tick(); assert.deepEqual(r.w.calls, []);
  }
});
test('both lanes wait for the Jev result and a second changed problem is not blocked by a running solver', async () => {
  let judgeDone; const { a,w } = rig({ judge: () => new Promise(r => { judgeDone = r; }) });
  const looking = a.look({ settled:true }); await tick(); assert.equal(w.calls.length,0);
  judgeDone(w.gate); await looking; await tick(); await tick();
  assert.deepEqual(w.calls.sort(), ['checker','fast']);
  assert.equal(a.looking, false);
  assert.equal(w.records.length,1); assert.equal(w.records[0].agreed, true);
});
test('Jev outage requires two stable OCR reads and empty OCR never falls open', async () => {
  const { a,w } = rig({ later: () => 1, cancel: () => {} }); w.gate = null;
  await a.look({ settled:true }); assert.equal(w.calls.length,0);
  await a.look({ settled:true }); await tick(); await tick(); assert.equal(w.calls.length,2);
  const empty = rig(); empty.w.text = ''; await empty.a.look({ settled:true }); assert.equal(empty.w.calls.length,0);
});
test('without Jev a typed answer or a submit does not re-solve, a new problem does', async () => {
  const { a,w } = rig({ judge: null, later: () => 1, cancel: () => {} });
  a.lookText = a.solveText = text; a.view = { problem:'Question 16', answer:'x^3 + C', steps:[], index:0 };
  w.text = text + ' 3 x ^ 3 + C'; await a.look({ settled:true }); await tick();
  w.text = text.replace('Question 16', 'Question 16 attempted 1 times') + ' 3 x ^ 3 + C'; await a.look({ settled:true }); await tick();
  assert.deepEqual(w.calls, []);
  w.text = 'Homework Question 17 Evaluate the integral of 5 x to the 4 and enter your answer';
  await a.look({ settled:true }); assert.equal(w.calls.length, 0);
  await a.look({ settled:true }); await tick(); await tick();
  assert.deepEqual(w.calls.sort(), ['checker','fast']);
});
test('criticalRemoved counts lost numbers with repeats and ignores added ones', () => {
  const { criticalRemoved } = require('../src/guide/assignment-watch');
  assert.equal(criticalRemoved('Problem 1 Problem 2 x^2 + 3', 'Problem 1 Problem 2 x^2 + 3 answer 9'), 0);
  assert.equal(criticalRemoved('Problem 1 Problem 2 / 2 x - 3', 'Problem 1 Problem 2 / 1 x + 5'), 3);
});
test('cache restores a checked view without Jev or Claude and rejects changed numeric problems', async () => {
  const { a,w } = rig({ judge: async () => { throw new Error('cache must precede Jev'); } });
  a.cache.push({ text, view: { problem:'Question 16', answer:'x^3 + C', steps:[{body:'Reason'}], index:0, checkState:'checked' } });
  await a.look({ settled:true }); assert.equal(w.calls.length,0); assert.equal(w.records[0].cacheHit,true);
  assert.equal(cacheSimilarity(text, text.replace('16','17')),0);
  assert.equal(cacheSimilarity('Question 1: x+2', 'Question 1: x-2'),0);
});
test('warm only runs on invocation, at most once per three seconds and never overlaps', async () => {
  let now = 0, calls = 0, finish;
  const warm = createWarm({ now: () => now, client: { ready: () => true, systemOne: () => { calls++; return new Promise(r => { finish=r; }); } } });
  warm(); warm(); await tick(); assert.equal(calls,1);
  now = 4000; warm(); await tick(); assert.equal(calls,1);
  finish(); await tick(); warm(); await tick(); assert.equal(calls,2); finish();
});
test('mask converts physical coordinates and only clears the actual bubble pixels', () => {
  const rect = imageRect({x:150,y:100,w:100,h:50}, {x:100,y:50}, {width:200,height:100}, {width:4,height:2});
  assert.deepEqual(rect,{x:1,y:1,width:2,height:1});
  const buf=Buffer.alloc(4*2*4, 7); maskBitmap(buf,4,2,rect);
  assert.equal(buf[0],7); assert.equal(buf[(1*4+1)*4],255); assert.equal(buf[(1*4+3)*4],7);
});

test('a new-problem cancellation retains the fast answer and first-token receipt already observed', async () => {
  const { a,w } = rig({ solveLane: p => {
    if (p.lane === 'fast') { p.onToken(fast); return Promise.resolve({text:fast}); }
    return new Promise((resolve,reject) => p.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'),{name:'AbortError'})),{once:true}));
  } });
  const job = a.solveNow({auto:true,text});
  await tick(); await tick(); a.stop(); await job;
  assert.equal(w.records[0].reason,'cancelled');
  assert.equal(w.records[0].fastReply.answer,'x^3 + C');
  assert.equal(typeof w.records[0].fastFirstTokenMs,'number');
});

test('mode activation clears a stale one-off result before the first same-problem gate', async () => {
  const {a}=rig(); a.on=false; a.view={problem:'Old one-off answer',answer:'42',steps:[]}; a.lookFrame=new Uint8Array(2);
  await a.start('voice',{solve:false});
  assert.equal(a.view,null); assert.equal(a.lookFrame,null); assert.equal(a.isOn(),true); a.stop();
});

test('a title change after detection retries unchanged OCR instead of permanently skipping the problem', async () => {
  let phase = 'loading';
  const ready = { hwnd: 1, process: 'firefox', title: 'assignment' };
  const scheduled = [];
  const {a,w} = rig({
    later: (ms,fn) => { scheduled.push(fn); return scheduled.length; }, cancel() {},
    capture: async opts => ({ foreground: opts.model || phase === 'ready' ? ready : {...ready,title:'Mozilla Firefox'}, dataUrl: opts.model ? 'data:image/jpeg;base64,AA' : null }),
  });
  a.lookText = text.replace('16','15'); a.solveText = a.lookText;
  a.view = {problem:'Question 15',answer:'old',steps:[],index:0};
  await a.look({settled:true}); await tick(); await tick();
  assert.equal(w.calls.length,0); assert.equal(a.lookText,text);
  assert.equal(a.needsStableLook,true);
  assert.equal(w.records[0].reason,'window changed during gate');
  assert.ok(scheduled.length);
  phase = 'ready';
  // The exact same OCR and even the same thumbnail must be reconsidered.
  a.lookFrame = new Uint8Array(1296);
  await a.lookSoon('capture retry'); await tick(); await tick();
  assert.deepEqual(w.calls.sort(),['checker','fast']);
  assert.equal(a.view.answer,'x^3 + C'); assert.equal(a.needsStableLook,false);
  assert.equal(w.records.at(-1).reason,'solved');
});

test('Alt+Tab after a model capture starts neither lane and records a recoverable reason', async () => {
  const fg = {hwnd:1,process:'firefox',title:'assignment'};
  const {a,w} = rig({foreground:async()=>({hwnd:2,process:'explorer',title:'Task Switching'}),later:()=>1,cancel(){}});
  await a.solveNow({auto:true,text,cap:{foreground:fg},modelCap:{dataUrl:'data:image/jpeg;base64,AA',foreground:fg}});
  assert.deepEqual(w.calls,[]); assert.equal(a.needsStableLook,true);
  assert.equal(w.records[0].reason,'window changed after capture');
});

test('invalidated OCR captures do not reach OCR or the gate and remain eligible for a fresh look', async () => {
  const {a,w} = rig({capture:async()=>({invalidated:true}),ocr:()=>{throw new Error('must not OCR stale image');},judge:()=>{throw new Error('must not gate stale image');},later:()=>1,cancel(){}});
  await a.look({settled:true}); assert.deepEqual(w.calls,[]); assert.equal(a.needsStableLook,true);
});

test('a vanished model capture rearms detection without a provider call', async () => {
  const {a,w} = rig({capture:async()=>null,later:()=>1,cancel(){}});
  await a.solveNow({auto:true,text});
  assert.deepEqual(w.calls,[]); assert.equal(a.needsStableLook,true);
  assert.equal(w.records[0].reason,'capture unavailable');
});

test('capture helper rejects a window switch during the worker screenshot before encoding', async () => {
  const {captureAssignment} = require('../src/guide/assignment-capture');
  let reads=0;
  const fg={hwnd:1,process:'firefox',title:'assignment',rect:{x:0,y:0,w:100,h:100}};
  const cap=await captureAssignment({foreground:async()=>++reads===1?fg:{...fg,hwnd:2,process:'explorer'},
    captureDisplay:async()=>({image:{getSize(){throw new Error('stale screenshot must not be encoded');}}}),
    electron:{nativeImage:{},screen:{screenToDipPoint:p=>p,dipToScreenPoint:p=>p,getDisplayNearestPoint:()=>({id:1,bounds:{x:0,y:0,width:100,height:100},scaleFactor:1})}}});
  assert.equal(cap.invalidated,true); assert.equal(cap.dataUrl,undefined); assert.equal(reads,2);
});
test('homeworkText accepts plural and multiple-choice WeBWorK wording, rejects a chat window', () => {
  const { homeworkText } = require('../src/guide/assignment-watch');
  // Real Windows OCR of DHW 7 Problem 1 on 2026-10-12: no singular "integral" or "answer" anywhere.
  const dhw7 = 'DHW7 WEBWORK Assignments Problem 1 Problem 2 Logged in as Pranav Desu. Previous Problem (1 point) Problem List Next Problem DHW 7 8.1-9.3 F26: Problem 1 Which of the following integrals represents the length of the curve A. B. C. D. E. 1+(1 + 3y2)2dy Preview My Answers Submit Answers You have attempted this problem 0 times.';
  assert.equal(homeworkText(dhw7), true);
  assert.equal(homeworkText('Homework Question 17 Evaluate the integral of 5 x to the 4 and enter your answer'), true);
  assert.equal(homeworkText('Problem 3 Determine whether the series converges or diverges. Submit Answers'), true);
  assert.equal(homeworkText('Claude chat window showing assignment mode status, no problem or question visible'), false);
  assert.equal(homeworkText('short problem'), false);
});
