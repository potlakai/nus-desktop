const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

test('assignment streaming forwards model effort tokens and usage without SDK retries', async () => {
  const old = Module._load; const requests = [], constructors = [];
  class FakeAnthropic {
    constructor(opts) { constructors.push(opts); this.messages = { create: async req => { requests.push(req); return (async function* () {
      yield { type:'message_start', message:{usage:{input_tokens:40,output_tokens:0}} };
      yield { type:'content_block_delta', delta:{type:'text_delta',text:'hello'} };
      yield { type:'message_delta', usage:{output_tokens:3}, delta:{stop_reason:'end_turn'} };
    })(); } }; }
  }
  Module._load = function(name,...rest) { return name === '@anthropic-ai/sdk' ? FakeAnthropic : old.call(this,name,...rest); };
  try {
    const { createLLM } = require('../src/llm');
    const llm = createLLM({provider:'anthropic',apiKeys:{anthropic:'test-only'},models:{anthropic:{fast:'default'}}});
    let tokens='',usage;
    await llm.complete({system:'S',turns:[{role:'user',text:'T'}],model:'claude-sonnet-5',effort:'low',maxTokens:512,assignment:true,onToken:t=>tokens+=t,onUsage:u=>usage=u});
    assert.equal(tokens,'hello'); assert.equal(requests[0].model,'claude-sonnet-5'); assert.deepEqual(requests[0].output_config,{effort:'low'});
    assert.equal(requests[0].max_tokens,512); assert.equal(constructors[0].maxRetries,0); assert.equal(usage.output_tokens,3);
    await llm.stream({system:'S',turns:[],model:'claude-haiku-4-5-20251001',effort:'low',maxTokens:768,assignment:true,onToken:()=>{}});
    assert.equal(requests[1].output_config,undefined); assert.equal(requests[1].max_tokens,768);
  } finally { Module._load=old; }
});
test('desktop API fallback honors per-call model and effort', async () => {
  const source=fs.readFileSync(path.join(__dirname,'../../src/ai.js'),'utf8');
  const body=source.slice(source.indexOf('async function runApi('),source.indexOf('\nfunction parseJsonBlock('));
  let request;
  const ctx={MODEL:'default',API_TIMEOUT_MS:100,AbortSignal,apiContent:p=>p,fetch:async (_url,p)=>{request=JSON.parse(p.body);return {ok:true,json:async()=>({content:[{type:'text',text:'ok'}]})};}};
  vm.runInNewContext(body+';this.runApi=runApi;',ctx);
  await ctx.runApi('test-only','prompt',{model:'claude-sonnet-5',effort:'medium'});
  assert.equal(request.model,'claude-sonnet-5'); assert.equal(request.output_config.effort,'medium');
});
