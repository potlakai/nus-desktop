const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { reserve, read, summary, DAILY_ATTEMPTS } = require('../src/guide/solve-budget');
test('the daily budget counts concurrent lanes, settles actual usage, and stops at the cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'assignment-budget-')), file=path.join(dir,'budget.json');
  try {
    const a=reserve(file,'claude-haiku-4-5-20251001',768,'fast');
    const b=reserve(file,'claude-sonnet-5',8000,'checker');
    a({input_tokens:2000,output_tokens:200}); b({input_tokens:3000,output_tokens:1000});
    let data=read(file); assert.equal(data.attempts.length,2); assert.equal(data.attempts[0].usd,0.003); assert.equal(data.attempts[1].usd,0.016);
    for(let i=2;i<DAILY_ATTEMPTS;i++) reserve(file,'claude-haiku-4-5-20251001',768,'fast');
    assert.throws(()=>reserve(file,'claude-haiku-4-5-20251001',768,'fast'),/spend limit/);
    assert.equal(read(file).attempts.length,DAILY_ATTEMPTS);
    const s=summary(file); assert.equal(s.attempts,DAILY_ATTEMPTS); assert.equal(s.capUsd,3); assert.ok(s.usd>0);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('unsettled or failed requests retain their conservative spend reservation within the day', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assignment-budget-')),file=path.join(dir,'budget.json');
  try {
    const day=read(file).day;
    fs.writeFileSync(file,JSON.stringify({day,attempts:[{reservedUsd:2.99,usd:null}]}));
    assert.throws(()=>reserve(file,'claude-sonnet-5',8000,'checker'),/spend limit/);
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('a ledger from another day, or the old lifetime shape, starts today empty', () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'assignment-budget-')),file=path.join(dir,'budget.json');
  try {
    fs.writeFileSync(file,JSON.stringify({day:'2026-01-01',attempts:new Array(70).fill({reservedUsd:0.09,usd:null})}));
    assert.equal(read(file).attempts.length,0);
    fs.writeFileSync(file,JSON.stringify({attempts:new Array(105).fill({reservedUsd:0.09,usd:null})}));
    assert.equal(read(file).attempts.length,0);
    reserve(file,'claude-sonnet-5',8000,'checker');
    assert.equal(read(file).attempts.length,1);
    assert.equal(read(file,'2030-01-01').attempts.length,0,'another day reads empty without touching the file');
  } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('only the person\'s own Anthropic key is metered; Claude Code and Gemini never reserve', () => {
  const main=fs.readFileSync(path.join(__dirname,'..','index.js'),'utf8');
  assert.match(main,/const metered = llm\.provider === 'anthropic';/);
  assert.match(main,/metered \? reserveSolveBudget\(/);
});
