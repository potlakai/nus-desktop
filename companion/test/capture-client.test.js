const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createCaptureClient } = require('../src/guide/capture-client');
function rig(timeoutMs = 100) {
  const child = new EventEmitter(); child.sent=[];
  child.send = (m, cb) => { child.sent.push(m); cb(); }; child.kill = () => { child.killed=true; };
  const c = createCaptureClient({ timeoutMs, launch: () => child, nativeImage: { createFromBitmap: (b, size) => ({ bytes: b.length, size }) } });
  return { child, c };
}
test('capture worker correlates overlapping requests and transports no base64', async () => {
  const {child,c}=rig(); const a=c.capture(1,{maxSide:240}), b=c.capture(1,{maxSide:960});
  const cap={ bitmap:Buffer.alloc(16),imageSize:{width:2,height:2},width:2,height:2,blockMs:77,dataUrl:null };
  child.emit('message',{id:2,cap}); child.emit('message',{id:1,cap});
  const [x,y]=await Promise.all([a,b]); assert.equal(x.image.bytes,16); assert.equal(y.dataUrl,null);
  assert.equal(x.workerImageOpsMs,77); assert.equal(child.sent[0].opts.dataUrl,false); c.close();
});
test('capture timeout terminates helper and rejects outstanding work', async () => {
  const {child,c}=rig(10); const result=Promise.allSettled([c.capture(1),c.capture(1)]);
  const out=await result; assert.equal(out.every(r=>r.status==='rejected'),true); assert.equal(child.killed,true); c.close();
});
