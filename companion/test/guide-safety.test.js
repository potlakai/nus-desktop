const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {sensitiveTarget}=require('../src/guide/sensitive');
const {reconcile}=require('../src/guide/verify');
const {createWalkthroughs}=require('../src/guide/walkthroughs');
const {appendEvent,outboxFile}=require('../src/nus-outbox');
const {GuideSession}=require('../src/guide/session');
test('protected controls are refused for element, bbox, and stored labels',()=>{
  for(const name of ['Password','verification code','creditCardNumber','CVV','SSN']) {
    assert.equal(sensitiveTarget({name,type:'Edit'}),true,name);
    const el={id:1,name,type:'Edit',rect:{x:1,y:1,w:80,h:30}};
    assert.equal(reconcile({target:{kind:'element',id:1},elements:[el]}),null);
    assert.equal(reconcile({target:{kind:'bbox',label:name},bboxPhys:el.rect,fromPoint:el}),null);
  }
  assert.equal(sensitiveTarget({name:'Change password',type:'Button'}),false);
  assert.equal(sensitiveTarget({name:'Account',type:'Edit',isPassword:true}),true);
});
test('browser replay requires a matching title even for exact task names',()=>{
  const w=createWalkthroughs();w.record({task:'save',app:{process:'chrome',title:'Canvas assignments'},steps:[{name:'Save',instruction:'Click Save'}]});
  assert.equal(w.find({process:'chrome',title:'Online banking',task:'save'}),null);
  assert.equal(w.find({process:'chrome',title:'',task:'save'}),null);
  assert.ok(w.find({process:'chrome',title:'Canvas',task:'save'}));
});
test('outbox retry keeps one summary per id and preserves distinct simultaneous events',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nus-outbox-'));
  try {assert.equal(appendEvent(dir,{id:'a',answer:'one'}),true);assert.equal(appendEvent(dir,{id:'a',answer:'one'}),true);assert.equal(appendEvent(dir,{id:'b',answer:'two'}),true);assert.equal(JSON.parse(fs.readFileSync(outboxFile(dir))).events.length,2);}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('failed Keep stays retryable; Skip clears it; stale session id cannot save',()=>{
  let failure=true,saves=0;const g=new GuideSession({send:()=>{},onKeep:()=>{if(failure)throw Error('disk');saves++}});
  g.lastRecord={id:'one',task:'help',steps:[]};
  assert.equal(g.keep('old').ok,false);assert.equal(g.keep('one').ok,false);assert.ok(g.lastRecord);
  failure=false;assert.equal(g.keep('one').ok,true);assert.equal(saves,1);assert.equal(g.keep('one').ok,false);
  g.lastRecord={id:'two'};g.skip('one');assert.ok(g.lastRecord);g.skip('two');assert.equal(g.lastRecord,null);
});
test('a walkthrough save failure is reported and does not remain in memory',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'nus-wt-denied-'));const blocker=path.join(dir,'blocker');fs.writeFileSync(blocker,'file');
  try {const w=createWalkthroughs({file:path.join(blocker,'walkthroughs.json')});assert.throws(()=>w.record({task:'save',app:{process:'editor'},steps:[{name:'Save'}]}));assert.equal(w.list().length,0);}
  finally {fs.rmSync(dir,{recursive:true,force:true});}
});
