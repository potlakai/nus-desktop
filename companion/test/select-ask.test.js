// 2026-09-15, Pranav's first play session on the day-1 build:
//   1. guide steps keep going in apps that expose nothing to UI Automation
//      (CapCut) instead of refusing;
//   2. the one-line composer no longer overlaps the status capsule;
//   3. Ctrl+Shift+T is back: point at the control under the cursor and ask.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const js = fs.readFileSync(path.join(root, 'renderer', 'renderer.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'renderer', 'styles.css'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.js'), 'utf8');
const { validatePoint, SYSTEM } = require('../src/guide/pointing');
const { reconcile } = require('../src/guide/verify');

test('a bbox a hair past the screen edge is trimmed, not rejected', () => {
  const r = validatePoint({ instruction: 'Click Start', target: { kind: 'bbox', x: 0.005, y: 0.983, w: 0.14, h: 0.03, label: 'Start' }, confidence: 0.9 }, []);
  assert.equal(r.ok, true, r.reason);
  assert.ok(Math.abs(r.reply.target.y + r.reply.target.h - 1) < 1e-9, 'bottom edge trimmed to the screen');
  const far = validatePoint({ instruction: 'x', target: { kind: 'bbox', x: 0.9, y: 0.1, w: 0.3, h: 0.1 }, confidence: 0.9 }, []);
  assert.equal(far.reason, 'bbox out of range', 'a box well past the edge is still a miss');
});

test('the pointing contract tells the model to keep going in apps with no control list', () => {
  assert.match(SYSTEM, /list few or no controls\. Then use a bbox/);
  assert.match(SYSTEM, /one click at a time/);
});

test('Windows disagreeing with the model box points at the box, flagged as a guess', () => {
  const bboxPhys = { x: 100, y: 100, w: 100, h: 40 };
  const r = reconcile({ target: { kind: 'bbox', label: 'Text' }, bboxPhys, fromPoint: { name: 'Whole window', rect: { x: 0, y: 0, w: 1900, h: 1000 } }, found: null, verified: true });
  assert.ok(r, 'never null for a bbox any more');
  assert.equal(r.verified, false);
  assert.equal(r.source, 'model');
  assert.deepEqual(r.rect, bboxPhys);
});

test('the capsule folds while the one-line composer is open', () => {
  assert.match(css, /#toolbar\.quick-open #knot-bloom \{ opacity: 0 !important;/);
  assert.match(js, /\$\('#toolbar'\)\.classList\.add\('quick-open'\);/);
  assert.match(js, /\$\('#toolbar'\)\.classList\.remove\('quick-open'\);/);
});

test('Ctrl+Shift+T selects the control under the cursor and opens the composer about it', () => {
  assert.match(main, /chord\('CommandOrControl\+Shift\+T', FOUNDER \? harnessStep : selectAtCursor\);/);
  assert.match(main, /async function selectAtCursor\(\)/);
  assert.match(main, /send\('guide:target', \{ bbox, task: 'ask', kicker: 'selected'/, 'the thread goes to the selection first');
  assert.match(main, /send\('quick:open', \{ context: /);
  assert.match(main, /if \(!win\.isAlwaysOnTop\(\)\) \{ console\.log\('\[select\] focus\(\) stripped topmost; restoring'\); await restoreTopmost\('select'\); \}/, 'focus() may strip topmost; put it back');
  assert.match(main, /\/password\|passcode\|card number\|cvv\|ssn\/i\.test\(name \+ ' ' \+ type\)/, 'never reads a password or card field');
  assert.match(preload, /'quick:open'\]/, 'the renderer may receive quick:open');
  assert.match(js, /nus\.on\('quick:open', \(p\) => openQuickAsk\(/);
  assert.match(js, /nus\.guideAsk\(\{ text, source: 'typed', about: !!about \}\)/);
});

test('a question about the selection is answered at the thread tip and can become a walkthrough', () => {
  assert.match(main, /if \(p\.about && selection\) \{ answerSelection\(p\.text\); return; \}/);
  assert.match(main, /if \(p && p\.action === 'walk' && selection\) \{ walkFromSelection\(\); return; \}/);
  assert.match(main, /send\('guide:bubble', \{ text: answer[^\n]*anchor: 'tip', task: 'ask'[^\n]*\{ id: 'walk', label: 'Walk me through it', primary: walk \}, \{ id: 'dismiss', label: 'OK' \}/);
  assert.match(main, /getGuide\(\)\.start\(sel\.question, 'typed'\);/);
  assert.match(main, /selection = null;\n  if \(wasActive\)/, 'Esc and a Knot click clear the selection');
});

test('guide steps through the Claude Code fallback ask for the fast model', () => {
  const ai = fs.readFileSync(path.join(root, '..', 'src', 'ai.js'), 'utf8');
  const desktop = fs.readFileSync(path.join(root, '..', 'src', 'main.js'), 'utf8');
  // Not Haiku: measured 2026-09-15 it pads its JSON with prose and is 4x slower.
  assert.match(main, /const GUIDE_FAST_MODEL = process\.env\.NUS_GUIDE_MODEL \|\| 'claude-sonnet-5';/);
  // The screenshot rides as an image block and the system prompt stays separate
  // (warm pool, prompt cache); no capture file is written for the model.
  assert.match(main, /hooks\.desktopComplete\(prompt, \{ model: GUIDE_FAST_MODEL, fast: true, system, image: imageDataUrl \|\| undefined, onDelta, \.\.\.\(signal \? \{ signal \} : \{\}\) \}\)/, 'the stop signal rides along (2026-10-31)');
  assert.match(ai, /const \{ createClaudePool \} = require\('\.\/claude-pool'\)/);
  assert.match(ai, /opts && opts\.image\) content\.push\(\{ type: 'image', dataUrl: opts\.image \}\)/);
  assert.match(ai, /FAST_CLI_ARGS = \['--strict-mcp-config', '--no-session-persistence', '--tools', 'Read', '--effort', 'low'\]/);
  assert.doesNotMatch(ai, /'--bare'/, 'bare mode skips the keychain and lands signed out');
  assert.match(desktop, /desktopComplete: \(prompt, opts\) => ai\.complete\(prompt, opts\),/);
  assert.match(ai, /async function complete\(prompt, opts = \{\}\)/);
  assert.match(ai, /'--model', model \|\| MODEL/, 'other callers keep the pinned default');
});

test('a hedged pick is pointed at as a best guess instead of refused', () => {
  const session = fs.readFileSync(path.join(root, 'src', 'guide', 'session.js'), 'utf8');
  const pointing = require('../src/guide/pointing');
  assert.equal(pointing.CONF_SURE, 0.6);
  assert.match(session, /const sure = hit\.verified && reply\.confidence >= CONF_SURE;/);
  assert.match(session, /verified: sure, source: hit\.source/);
  const llm = fs.readFileSync(path.join(root, 'src', 'llm.js'), 'utf8');
  assert.match(llm, /thinkingConfig = \{ thinkingBudget: 0 \}/, 'Gemini Flash thinking off so the JSON budget is not eaten');
  assert.match(llm, /Math\.max\(Number\(maxTokens\) \|\| 0, 1024\)/);
});

test('NUS_GUIDE_PROVIDER=claude forces guide steps onto Claude Code even with a Companion key', () => {
  assert.match(main, /const FORCE_CLAUDE_GUIDE = process\.env\.NUS_GUIDE_PROVIDER === 'claude';/);
  assert.match(main, /if \(own\.ready && !FORCE_CLAUDE_GUIDE\) return own;/);
});

test('the CLI runs in userData so it may Read the guide screenshot written there', () => {
  // 2026-09-15: a temp cwd made every guide step a blind guess ("Could not view the screenshot").
  const ai = fs.readFileSync(path.join(root, '..', 'src', 'ai.js'), 'utf8');
  assert.match(ai, /const opts = \{ cwd: app\.getPath\('userData'\), env: cliEnv\(\), windowsHide: true \};/);
  assert.doesNotMatch(ai, /getPath\('temp'\)/);
  assert.match(main, /path\.join\(app\.getPath\('userData'\), 'companion', 'captures'\)/, 'screenshot lives under userData');
});
