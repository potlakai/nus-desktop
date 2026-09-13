const test=require('node:test'),assert=require('node:assert/strict');
const {drainCapture}=require('../src/capture-drain');
test('Stop waits for in-flight words and both buffered tails before closing history',async()=>{
  const history=[];let finishPending;const pending=new Promise(r=>finishPending=r);
  const done=drainCapture({pending:[pending],flush:async channel=>{history.push(channel+' tail');},finish:()=>history.push('closed')});
  await new Promise(setImmediate);assert.deepEqual(history,[]);
  history.push('in-flight words');finishPending();await done;
  assert.deepEqual(history,['in-flight words','you tail','them tail','closed']);
});
test('a failed channel does not strand the other channel or the closing session',async()=>{
  const completed=[];
  await drainCapture({pending:[Promise.reject(Error('provider'))],flush:async channel=>{if(channel==='you')throw Error('mic');completed.push(channel);},finish:()=>completed.push('closed')});
  assert.deepEqual(completed,['them','closed']);
});
