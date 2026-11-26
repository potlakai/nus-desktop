'use strict';
// The Windows build workflow, checked against the app it claims to build.
//
// A workflow is a second, unwritten copy of the build: it names an exe, an asar
// path and a set of artifacts, and none of those are checked by running it. If
// the builder renames the product, or the asar stops being at the path the scan
// reads, CI fails at 3am rather than here. These tests keep the two in step.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const workflow = read('.github/workflows/build-windows.yml');
const builder = require('../electron-builder.config');

const lines = workflow.split('\n');
// The step body under a name, up to the next step.
function stepBody(name) {
  const at = lines.findIndex((l) => l.includes('name: ' + name));
  assert.ok(at > 0, 'the step exists: ' + name);
  const out = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (/^ {6}- /.test(lines[i]) || /^ {6}(uses|with):/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

test('the workflow triggers by hand only, and never publishes a release', () => {
  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/, 'manual trigger only');
  assert.doesNotMatch(workflow, /^\s{2}(push|pull_request|schedule):/m, 'no automatic runs');
  assert.match(workflow, /--publish never/, 'the build does not publish');
  assert.doesNotMatch(workflow, /gh release create/, 'attaching a release stays a human command');
});

test('the exe name in the smoke step is the name the builder produces', () => {
  const body = stepBody('Smoke the unpacked app');
  const named = [...body.matchAll(/dist\\win-unpacked\\([A-Za-z0-9 ._-]+\.exe)/g)].map((m) => m[1]);
  assert.ok(named.length > 0, 'the step runs an exe');
  for (const exe of named) {
    assert.equal(exe, builder.productName + '.exe', 'electron-builder names the unpacked exe after productName');
  }
});

test('the asar the scan reads is at the path electron-builder writes', () => {
  const body = stepBody('Scan the packed asar');
  assert.match(body, /dist\/win-unpacked\/resources\/app\.asar\b/);
  // An asar exists unless the build is told not to make one.
  assert.notEqual(builder.asar, false, 'the build must produce an asar for the scan to mean anything');
});

test('every artifact the workflow uploads has a name the builder is configured to produce', () => {
  const block = workflow.slice(workflow.indexOf('upload-artifact'));
  const uploaded = [...block.matchAll(/^\s+dist\/(\S+)\s*$/gm)].map((m) => m[1]);
  assert.ok(uploaded.length >= 3, 'it uploads the installers: ' + uploaded.join(', '));

  const nsisName = builder.win.artifactName.replace('${ext}', 'exe');
  const portableName = builder.portable.artifactName.replace('${ext}', 'exe');
  for (const file of uploaded) {
    const expected = [nsisName, portableName, nsisName + '.blockmap', 'latest.yml'];
    assert.ok(expected.includes(file), file + ' is produced by electron-builder; known: ' + expected.join(', '));
  }
  // And the two installers themselves are both uploaded: a run that shipped
  // only one of them would be a silent change of what a download is.
  assert.ok(uploaded.includes(nsisName), 'the installer is uploaded');
  assert.ok(uploaded.includes(portableName), 'the portable exe is uploaded');
});

test('the build actually launches what it ships', () => {
  const body = stepBody('Smoke the unpacked app');
  assert.match(body, /--smoke/, 'it runs the app with --smoke');
  assert.match(body, /smoke ok/, 'and fails when the app does not report it');
  assert.match(body, /NUS_SMOKE_DATA_DIR/, 'with an isolated profile, never the runner real one');
});

test('the voice model is fetched, and against the same pin the app checks', () => {
  // vendor/ is gitignored: nothing in a clean checkout has the model, and
  // `npm run dist` starts with a script that needs it.
  assert.match(read('.gitignore'), /^vendor\/$/m, 'vendor is not in the tree');
  const body = stepBody('Fetch the Fable voice model for the pre-built lines');
  const pinned = body.match(/\$want = '([0-9a-f]{64})'/);
  assert.ok(pinned, 'the fetch pins a full 64-character hash, not a prefix');

  const voice = read('companion/src/voice/index.js');
  assert.ok(voice.includes(pinned[1]), 'the workflow pin is the one in companion/src/voice/index.js');
  assert.match(body, /Get-FileHash -Algorithm SHA256/, 'it checks the hash');
  assert.match(body, /-ne \$want/, 'and fails on a mismatch rather than carrying on');
});

test('the workflow asks for no server credentials', () => {
  // No accounts in this build, so no Supabase project to configure. The two
  // remaining integrations are optional and may be empty.
  assert.doesNotMatch(workflow, /NUS_SUPABASE_URL:\s*\$\{\{\s*secrets/, 'no Supabase secret is requested');
  assert.doesNotMatch(workflow, /NUS_SUPABASE_ANON_KEY:\s*\$\{\{\s*secrets/);
  assert.match(workflow, /node scripts\/write-config\.js/, 'config.js is still rendered, or startup fails');
});

test('the config step cannot fail on an unset optional secret', () => {
  // write-config exits on a missing value, so an unset Google or Outlook secret
  // would fail the build for a feature nobody asked for. The step fills them.
  const body = stepBody('Write src/config.js');
  assert.match(body, /Set-Item "env:\$n" ''/, 'missing optional secrets become empty strings');
});

test('what the code reads from resources is what the builder puts there', () => {
  // The app reads its voice and its pre-made lines from process.resourcesPath.
  // extraResources is the only thing that puts them there, and a missing entry
  // is invisible: the app runs, and simply speaks in the wrong voice.
  const targets = (builder.win.extraResources || []).map((r) => r.to);
  for (const wanted of ['whisper', 'win', 'voice', 'voice-lines']) {
    assert.ok(targets.includes(wanted), 'win.extraResources copies to ' + wanted + '; has: ' + targets.join(', '));
  }
  const voice = read('companion/src/voice/index.js');
  assert.match(voice, /path\.join\(process\.resourcesPath, 'voice'\)/, 'voice/index.js reads resources/voice');
  const lineFile = read('companion/src/voice/lines.js');
  assert.match(lineFile, /path\.join\(resourcesPath, 'voice-lines'\)/, 'lines.js reads resources/voice-lines');
});

test('the dist script builds the lines before it packs them', () => {
  // vendor/voice-lines is made, not committed, so a dist that skips the script
  // packs nothing and the extraResources glob quietly matches no files.
  const pkg = require('../package.json');
  assert.match(pkg.scripts.dist, /^node scripts\/make-voice-lines\.js/);
  assert.match(pkg.scripts.dist, /electron-builder --win/);
});
