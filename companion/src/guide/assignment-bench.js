'use strict';
const fs = require('fs');
const path = require('path');
const { FAST_SYSTEM, partialReply, parseFast } = require('./solve-stream');
const { buildSolveRequest, parseSolveReply } = require('./solve');

function fixturePath(dir, name) {
  if (!/^[a-zA-Z0-9_-]+\.(jpg|png)$/.test(String(name))) throw new Error('invalid fixture name');
  return path.join(dir, name);
}
function createBench({ dir, assignment, capture, oldCapture, ocr }) {
  let busy = false;
  return async function bench(p) {
    if (busy) throw new Error('benchmark already running');
    const a = assignment();
    if (a.isOn() || a.solving) throw new Error('turn assignment mode off before bench');
    busy = true;
    try {
      if (p.op === 'capture') {
        const cap = await capture({ model: true });
        if (!cap?.jpeg) throw new Error('no foreground image');
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(fixturePath(dir, p.file), cap.jpeg, { flag: 'wx' });
        return { file: p.file, width: cap.width, height: cap.height, foreground: cap.foreground };
      }
      if (p.op === 'diagnose') {
        const result = {};
        for (const [label, get] of [['before', oldCapture], ['after', () => capture({ model: false })]]) {
          const t = performance.now(), cap = await get(), captured = performance.now();
          const text = await ocr(cap);
          result[label] = { capMs: captured - t, ocrMs: performance.now() - captured, blockMs: cap.blockMs, imageBytes: cap.jpeg.length, chars: text.length, base64: !!cap.dataUrl };
        }
        return result;
      }
      if (p.op !== 'run') throw new Error('unknown benchmark operation');
      if (!['claude-haiku-4-5-20251001', 'claude-sonnet-5'].includes(p.model) || !['fast', 'checker'].includes(p.lane)) throw new Error('invalid benchmark configuration');
      const jpeg = await fs.promises.readFile(fixturePath(dir, p.file));
      if (jpeg.length > 10 * 1024 * 1024) throw new Error('fixture too large');
      const cap = { jpeg, dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64') };
      const req = buildSolveRequest({ auto: false, question: 'Solve the problem in this image.' });
      const started = Date.now(), gen = ++a.gen;
      a.style = p.lane === 'fast' ? 'answers' : 'walkthrough';
      a.view = { problem: '', answer: '', steps: [], index: 0, voice: false, checkState: 'checking' };
      let raw = '', firstTokenMs = null, answerPaintMs = null, firstStepMs = null, answerSent = false, stepSent = false;
      const paints = [];
      const paint = (kind, expected, key) => paints.push(a.d.paint({ kind, expected, changeSeenAt: started, gen }).then(ms => { if (key === 'answer') answerPaintMs = ms; else firstStepMs = ms; }));
      const consume = token => {
        if (firstTokenMs == null) firstTokenMs = Date.now() - started;
        raw += token; const v = partialReply(raw);
        if (v.found !== true) return;
        if (v.steps?.length || v.answer) { a.view = { ...a.view, ...v }; a.show(); }
        if (p.lane === 'fast' && v.answer && !answerSent) { answerSent = true; paint('answer', v.answer, 'answer'); }
        if (p.lane === 'checker' && v.steps?.length && !stepSent) { stepSent = true; paint('step', v.steps[0].body, 'step'); }
      };
      const out = await a.d.solveLane({ lane: p.lane, model: p.model, effort: /haiku/.test(p.model) ? undefined : p.lane === 'fast' ? 'low' : 'medium', maxTokens: /haiku/.test(p.model) ? 768 : p.lane === 'fast' ? 4096 : 8000, system: p.lane === 'fast' ? FAST_SYSTEM : req.system, text: req.text, cap, onToken: consume });
      const totalMs = Date.now() - started;
      const reply = p.lane === 'fast' ? parseFast(out.text) : parseSolveReply(out.text).reply;
      if (!reply?.found || !reply.answer) throw new Error('no benchmark answer');
      a.view = { ...a.view, ...reply, checkState: p.lane === 'checker' ? 'checked' : 'checking' }; a.show();
      if (!answerSent) { answerSent = true; paint(p.lane === 'checker' ? 'checked' : 'answer', reply.answer, 'answer'); }
      await Promise.all(paints);
      return { file: p.file, model: p.model, lane: p.lane, firstTokenMs, answerPaintMs, firstStepMs, totalMs, reply };
    } finally { busy = false; }
  };
}
module.exports = { createBench, fixturePath };
