const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
test('actual listener routes early voice commands while assignment, selection and busy state are active', () => {
  const body = source.slice(source.indexOf('function getListener()'), source.indexOf('function flash('));
  const routed = [];
  const ctx = { listener: null, app: { getPath: () => 'unused' }, console,
    ptt: { held: true, finals: 0 }, selection: {}, state: { busy: true }, assignment: { isOn: () => true },
    earlyVoiceCommand: require('../src/guide/assignment-router').earlyVoiceCommand,
    createListener: options => options, getParakeet: () => null, routeUtterance: (...args) => routed.push(args), heardSegment: () => {}, showHeard: () => {} };
  vm.runInNewContext(body + '; getListener();', ctx);
  assert.equal(ctx.listener.onCommand('voice mode', {seg:1}), false);
  assert.equal(ctx.listener.onCommand('voice mode off', {seg:1,heardAt:123}), true);
  assert.deepEqual(routed, [['voice mode off', 'voice', 123, 1]]);
  ctx.ptt.held = false;
  assert.equal(ctx.listener.onCommand('voice mode on', {seg:2}), false);
  assert.equal(routed.length, 1);
});
test('actual watcher idle wiring keeps running with open mic and clears only real owners', () => {
  const expr = source.match(/idle: \(\) => (Boolean\(win[^\n]+),/)[1];
  const state = { win: { isDestroyed:()=>false, isVisible:()=>true }, guide:null, selection:null, harness:{active:false}, ptt:{held:true}, state:{busy:true}, activeNudge:{} };
  assert.equal(vm.runInNewContext(expr,state),true);
  state.selection = {}; assert.equal(vm.runInNewContext(expr,state),false);
  state.selection = null; state.guide = {active:()=>true}; assert.equal(vm.runInNewContext(expr,state),false);
  state.guide = null; state.harness.active=true; assert.equal(vm.runInNewContext(expr,state),false);
});
test('actual assignment handoff clears selection, composer and mic without flushing duplicate speech', () => {
  const close = source.slice(source.indexOf('function closeAssignmentMic('), source.indexOf('async function assignmentRoute('));
  const sent=[];
  const ctx = { selectionGeneration:1, OPEN_MIC:true, ptt:{held:true,timer:null,chunks:[1],streaming:true}, listener:{reset(){ctx.resets++;}}, resets:0, send:(c,p)=>sent.push([c,p]), guide:null, selection:{}, harness:{active:false}, guideDismiss(){ctx.selection=null;}, win:{isDestroyed:()=>false,blur(){ctx.blurred=true;}}, overlayMouse:{set(v){ctx.ignore=v;}}, clearTimeout, stopMacReleaseWatch(){} };
  vm.runInNewContext(close + '; releaseAssignmentSelection(); closeAssignmentMic("voice");',ctx);
  assert.equal(ctx.selection,null); assert.equal(ctx.ptt.held,false); assert.equal(ctx.ptt.streaming,false); assert.equal(ctx.resets,1);
  assert.equal(ctx.ignore,true); assert.ok(sent.some(s=>s[0]==='assignment:takeover'));
  assert.equal(ctx.selectionGeneration,2,'in-flight selection reads are invalidated too');
});

test('mode off also clears a one-off answer made before mode activation', () => {
  const off=source.slice(source.indexOf('function assignmentOff()'),source.indexOf('// After a spoken command'));
  let stopped=0; const ctx={assignmentTimer:null,assignmentPulseTimer:null,probe:null,guide:null,assignment:{isOn:()=>false,view:{answer:'42'},stop:()=>stopped++},flash(){},clearInterval};
  vm.runInNewContext(off+'; assignmentOff();',ctx); assert.equal(stopped,1);
});
