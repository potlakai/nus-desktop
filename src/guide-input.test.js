const test=require('node:test');
const assert=require('node:assert/strict');
const {guideInput}=require('./guide-input');
const {trustedSender}=require('./ipc-origin');
test('guide image is the same inline payload for API and CLI, with no agent tools or saved session',()=>{
  const input=guideInput('Explain this screen','data:image/png;base64,AAAA');
  assert.deepEqual(JSON.parse(input.stdin).message.content,input.content);
  assert.equal(input.content[1].source.media_type,'image/png');
  assert.ok(input.cliArgs.includes('--tools='));
  assert.ok(input.cliArgs.includes('--strict-mcp-config'));
  assert.ok(input.cliArgs.includes('--no-session-persistence'));
  assert.throws(()=>guideInput('x','file:///private.png'));
});
test('only the owning live main frame may use desktop or companion IPC',()=>{
  const frame={}, contents={mainFrame:frame,isDestroyed:()=>false};
  assert.equal(trustedSender({sender:contents,senderFrame:frame},contents),true);
  assert.equal(trustedSender({sender:contents,senderFrame:{}},contents),false);
  assert.equal(trustedSender({sender:{},senderFrame:frame},contents),false);
  assert.equal(trustedSender({sender:contents,senderFrame:frame},null),false);
  contents.isDestroyed=()=>true;
  assert.equal(trustedSender({sender:contents,senderFrame:frame},contents),false);
});
