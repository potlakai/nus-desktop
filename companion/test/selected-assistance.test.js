const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cropRect, cropSelection, sameApp, claudeClient, answerSelection } = require('../src/selected-assistance');

test('selection crop maps work-area DIPs into the chosen display at every requested scaling', () => {
  for (const scale of [1, 1.25, 1.5, 2]) {
    const cap = { width: 1920 * scale, height: 1080 * scale, display: { bounds: { x: -1920, y: 0, width: 1920, height: 1080 } } };
    const rect = cropRect({ x: 100, y: 120, w: 200, h: 80 }, cap, { x: -1920, y: 40, width: 1920, height: 1040 });
    assert.deepEqual(rect, { x: 100 * scale, y: 160 * scale, width: 200 * scale, height: 80 * scale });
  }
});

test('fractional crop rounds inward and excludes pixels outside the selection', () => {
  const rect = cropRect({ x: 0.1, y: 0.1, w: 9.8, h: 9.8 }, { width: 125, height: 125, display: { bounds: { x: 0, y: 0, width: 100, height: 100 } } }, { x: 0, y: 0, width: 100, height: 100 });
  assert.deepEqual(rect, { x: 1, y: 1, width: 11, height: 11 });
});

test('invalid, off-display and stale-display selections never become a full-display fallback', () => {
  const cap = { width: 100, height: 100, display: { bounds: { x: 0, y: 0, width: 100, height: 100 } } };
  const bounds = { x: 0, y: 0, width: 100, height: 100 };
  for (const rect of [null, { x: NaN, y: 1, w: 10, h: 10 }, { x: -1, y: 0, w: 10, h: 10 }, { x: 95, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 0, h: 10 }]) assert.throws(() => cropRect(rect, cap, bounds));
  assert.throws(() => cropRect({ x: 1, y: 1, w: 10, h: 10 }, cap, { ...bounds, x: 100 }));
});

test('only cropped pixels are serialized and a large crop is resized after cropping', () => {
  let cropped = false, resized = false;
  const crop = { getSize: () => ({ width: 2000, height: 1000 }), resize: (opts) => { resized = true; assert.equal(opts.width, 1600); return { toDataURL: () => 'selected-only' }; } };
  const nativeImage = { createFromDataURL: () => ({ isEmpty: () => false, crop: (r) => { cropped = true; assert.equal(r.width, 2000); return crop; }, toDataURL: () => assert.fail('full display serialized') }) };
  const result = cropSelection({ x: 100, y: 100, w: 2000, h: 1000 }, { dataUrl: 'local-display', width: 3000, height: 2000, display: { bounds: { x: 0, y: 0, width: 3000, height: 2000 } } }, { x: 0, y: 0, width: 3000, height: 2000 }, nativeImage);
  assert.equal(result, 'selected-only'); assert.equal(cropped && resized, true);
});

test('Claude selection routing ignores the generic provider preference', () => {
  const own = { ready: true, provider: 'anthropic' };
  assert.equal(claudeClient({ provider: 'gemini' }, (settings) => { assert.equal(settings.provider, 'anthropic'); return own; }), own);
  assert.throws(() => claudeClient({}, () => ({ ready: true, provider: 'gemini' })), /Connect Claude/);
});

test('desktop Claude receives only the supplied crop and local conversation', async () => {
  const client = claudeClient({}, () => ({ ready: false }), async (prompt, image) => {
    assert.equal(image, 'selected-image'); assert.match(prompt, /question/); return { text: 'answer' };
  });
  assert.equal(client.provider, 'anthropic');
  assert.equal(await client.complete({ system: 'system', turns: [{ role: 'user', text: 'question' }], imageDataUrl: 'selected-image' }), 'answer');
});

test('selected requests refuse non-Claude destinations before any model call', async () => {
  await assert.rejects(answerSelection({ selected: { imageDataUrl: 'crop' }, client: { provider: 'gemini', complete: () => assert.fail('wrong provider called') }, text: 'help' }), /only.*Claude/);
});

test('follow-up sends the same selected crop and bounded conversation, never the local display', async () => {
  const selected = { imageDataUrl: 'crop', capture: { dataUrl: 'PRIVATE-FULL-DISPLAY' }, source: 'user-selected', createdAt: 123, turns: Array.from({ length: 20 }, (_, i) => ({ role: 'user', text: 'question ' + i })) };
  const result = await answerSelection({ selected, text: 'Why?', intent: 'explain', client: { provider: 'anthropic', complete: async request => {
    assert.equal(request.imageDataUrl, 'crop'); assert.equal(request.turns.length, 11);
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE-FULL-DISPLAY/);
    assert.match(request.system, /untrusted data/);
    return JSON.stringify({ answer: 'Because this is the selected option.', pointToSelection: true });
  } } });
  assert.equal(result.answer, 'Because this is the selected option.'); assert.equal(result.pointToSelection, true);
});

test('cancellation rejects a pending desktop response and drops a late completion', async () => {
  let resolve; const controller = new AbortController(); let modelSignal;
  const work = answerSelection({ selected: { imageDataUrl: 'crop' }, text: 'help', signal: controller.signal, client: { provider: 'anthropic', complete: request => { modelSignal = request.signal; return new Promise(r => { resolve = r; }); } } });
  controller.abort(); await assert.rejects(work, /Cancelled/); assert.equal(modelSignal.aborted, true);
  resolve('late answer');
});

test('selected requests time out and abort the configured model request', async () => {
  let signal;
  await assert.rejects(answerSelection({ selected: { imageDataUrl: 'crop' }, text: 'help', timeoutMs: 5, client: { provider: 'anthropic', complete: request => { signal = request.signal; return new Promise(() => {}); } } }), /too long/);
  assert.equal(signal.aborted, true);
});

test('unstructured answers never invent a pointing target', async () => {
  const result = await answerSelection({ selected: { imageDataUrl: 'crop' }, text: 'help', client: { provider: 'anthropic', complete: async () => 'I need a larger selection to explain this.' } });
  assert.equal(result.pointToSelection, false);
});

test('foreground validation rejects app, page and unknown-window changes', () => {
  const selected = { hwnd: 10, title: 'Settings', process: 'app' };
  assert.equal(sameApp(selected, { ...selected }), true);
  for (const current of [null, { ...selected, hwnd: 11 }, { ...selected, title: 'Other page' }, { ...selected, process: 'other' }]) assert.equal(sameApp(selected, current), false);
});

test('production inspection keeps unrelated desktop context and generic provider routing out of its request', () => {
  const main = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const body = main.slice(main.indexOf('async function submitInspection(p)'), main.indexOf('// -------- the guide session --------'));
  assert.match(body, /claudeClient/);
  assert.doesNotMatch(body, /companionContext\(|buildCompanionContext\(|featureLlm\(|askTurns\.push/);
  assert.match(body, /selected\.capture = null/);
  assert.match(body, /inspectionTargetStillValid/);
  assert.match(body, /controller\.signal\.aborted/);
});

test('a null foreground (the Companion itself has focus) never counts as "the app changed"', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /if \(selected\.window && fg && !sameApp\(selected\.window, fg\)\) \{/, 'send refuses only when a different real app is in front');
  assert.match(main, /const fg = await getGuide\(\)\.foreground\(\);\n\s+if \(fg && !sameApp\(selected\.window, fg\)\) return false;/, 'pointer revalidation tolerates our own focus and relies on uia.frompoint');
});

test('a selected control hidden under the Nūs dashboard is not pointed at', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /function coveredByOwnWindow\(dip\)/);
  assert.match(main, /if \(w === win \|\| w\.isDestroyed\(\) \|\| !w\.isVisible\(\) \|\| w\.isMinimized\(\)\) return false;/, 'the overlay itself never counts as cover');
  assert.match(main, /if \(!fg && coveredByOwnWindow\(\{ x: b\.x \+ r\.x \+ r\.w \/ 2, y: b\.y \+ r\.y \+ r\.h \/ 2 \}\)\) return false;/);
});

test('a window-sized accessibility hit is not offered as a control; bounded nearby context is used instead', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /if \(hit && hit\.bbox && hit\.bbox\.w \* hit\.bbox\.h > 0\.25 \* bounds\.width \* bounds\.height\) \{[^\n]*hit = null; \}/);
  assert.match(main, /const nearby = pointContext\(invokedPoint, bounds\)/);
});

test('Ctrl+Shift+T unwinds the thread to the selected control at once, before any answer (2026-09-10 evening)', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /sendInspectionReady\(\);\r?\n\s+pointAtSelection\(\);/, 'pointing follows the selection announcement in inspectAtCursor');
  assert.match(main, /if \(!inspection \|\| !inspection\.bbox \|\| inspection\.source !== 'accessibility'\) return;/, 'verified-control branch still excludes drawn regions');
  assert.match(main, /inspection\?\.source === 'point-context' && inspection\.marker/, 'a deliberate arbitrary point has its own explicitly labeled branch');
  assert.match(main, /Your spot · not a detected control/);
  assert.match(main, /send\('guide:target', \{ bbox: inspection\.bbox, task: 'ask', generation: inspectionGeneration, kicker: 'Selected · ' \+ \(inspection\.name \|\| inspection\.type\), text: '', hint: 'Enter explains it\. Type a question for more\. Escape lets go\.', actions: \[\] \}\);/);
});

test('nearby-area help asks for the issue without inventing a control or uploading the whole display', async () => {
  const selected = { source: 'point-context', imageDataUrl: 'nearby-crop', capture: { dataUrl: 'PRIVATE-DESKTOP' }, point: { x: 50, y: 20 }, bbox: { x: 0, y: 0, w: 100, h: 80 } };
  const result = await answerSelection({ selected, text: 'What is here?', intent: 'explain', client: { provider: 'anthropic', complete: async request => {
    assert.equal(request.imageDataUrl, 'nearby-crop');
    assert.doesNotMatch(JSON.stringify(request), /PRIVATE-DESKTOP/);
    assert.match(request.system, /ask one useful clarifying question/);
    assert.match(request.system, /NOT a verified control/);
    assert.deepEqual(JSON.parse(request.turns.at(-1).text).selected.pointWithinSnapshot, { xFraction: 0.5, yFraction: 0.25 });
    return JSON.stringify({ answer: 'I see a paragraph. What would you like help understanding?', pointToSelection: true });
  } } });
  assert.equal(result.pointToSelection, false);
});

test('an expired Claude Code login reads as signed out, not as a generic failure (2026-09-10)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const { describeClaudeError } = require('../src/selected-assistance');
  assert.match(describeClaudeError({ error: 'cli_not_logged_in', detail: 'Failed to authenticate: OAuth session expired and could not be refreshed' }), /Claude is signed out\. Reconnect Claude in Nūs desktop Settings/);
  assert.match(describeClaudeError({ error: 'cli_spend_limit' }), /usage limit/);
  assert.match(describeClaudeError({ error: 'no_ai' }), /Connect Claude in Nūs desktop settings first\./);
  assert.match(describeClaudeError({ error: 'cli_failed' }), /Claude could not answer\. Your selection is kept; try again\./);
  const ai = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'ai.js'), 'utf8');
  assert.equal((ai.match(/failed to authenticate\|oauth session expired\|session expired\|could not be refreshed/g) || []).length, 2, 'both CLI error classifiers recognise an expired OAuth session');
  const main = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(main, /throw new Error\(r && r\.error \? describeClaudeError\(r\) : 'No model response'\);/, 'the guide fallback uses the same wording');
});
