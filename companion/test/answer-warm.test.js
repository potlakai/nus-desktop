'use strict';
// A plain spoken answer must find a warm Claude Code spare: the prompt warmed
// at key down is the exact prompt answerPlain sends, with the memory block in
// it once. Runs the real functions from index.js in a sandbox.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const slice = (from, to) => { const a = main.indexOf(from), b = main.indexOf(to, a); assert.ok(a >= 0 && b > a, from); return main.slice(a, b); };
const prompts = slice('function guideSystemPrompt(', 'function companionGuideContext(');
const warm = slice('function warmGuideBrain()', 'let lastDesktopWarm') + slice('let recallWarmedAt = 0;', '// A memory ask');
const answer = slice('async function answerPlain(', '// -------- rewrite the selection');
const MEM = 'What Nūs knows: name Pranav.';

function sandbox(standalone, hands) {
  const warmed = [];
  const ctx = {
    STANDALONE: standalone, ANSWER_SYSTEM: 'ANSWER', GUIDE_FAST_MODEL: 'sonnet', FORCE_CLAUDE_GUIDE: false, process: { env: {} },
    appGuide: () => 'APP GUIDE', memoryBlock: () => '\n\n' + MEM, handsOn: () => hands,
    store: { getSettings: () => ({ voice: 'system' }) }, getVoice: () => ({ warm() {} }), createLLM: () => ({ ready: false }),
    hooks: { desktopWarm: (o) => { warmed.push(o); return Promise.resolve(true); } },
    require: (p) => require(path.join(root, p)), Promise, Date,
  };
  vm.runInNewContext(prompts + warm, ctx);
  return { ctx, warmed };
}
const count = (s, sub) => s.split(sub).length - 1;

test('a standalone plain answer carries the memory block once', () => {
  const { ctx } = sandbox(true, false);
  // answerPlain's prompt, then the standalone wrapper's guideSystemPrompt on top.
  const sent = vm.runInNewContext('guideSystemPrompt(answerSystem(ANSWER_SYSTEM))', ctx);
  assert.equal(count(sent, MEM), 1);
  assert.match(sent, /^ANSWER\n\nAPP GUIDE\n\nWhat Nūs knows/);
  assert.match(answer, /const system = answerSystem\(opts\.system \|\| ANSWER_SYSTEM\);/);
  assert.doesNotMatch(answer, /\+ memoryBlock\(\)/);
  // The ledger row says whether a warm spare answered.
  assert.match(answer, /warm: llm && typeof llm\.warmHint === 'function' \? llm\.warmHint\(\) === true : undefined/);
});

test('in the desktop app (no wrapper) the answer still gets the memory block, once', () => {
  const { ctx } = sandbox(false, false);
  assert.equal(count(vm.runInNewContext('answerSystem(ANSWER_SYSTEM)', ctx), MEM), 1);
});

test('key down warms the guide, Hands and plain-answer prompts, the answer one exactly as sent', () => {
  const { ctx, warmed } = sandbox(true, true);
  vm.runInNewContext('warmGuideBrain()', ctx);
  assert.equal(warmed.length, 3, 'guide, Hands, answer');
  const systems = warmed.map((w) => w.system);
  assert.equal(new Set(systems).size, 3, 'three different spares');
  const sent = vm.runInNewContext('guideSystemPrompt(answerSystem(ANSWER_SYSTEM))', ctx);
  const a = warmed.find((w) => w.system === sent);
  assert.ok(a, 'the answer spare matches what answerPlain sends');
  assert.deepEqual({ model: a.model, fast: a.fast }, { model: 'sonnet', fast: true }, 'same model and effort as the guide brain call');
  for (const s of systems) assert.equal(count(s, MEM), 1);
  // Hands off: still the answer spare.
  const off = sandbox(true, false);
  vm.runInNewContext('warmGuideBrain()', off.ctx);
  assert.equal(off.warmed.length, 2);
});
