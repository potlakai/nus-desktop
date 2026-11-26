'use strict';
// Lighter on a student laptop (measured 2026-11-07 on a Ryzen 4700U): the Knot's
// breathing states draw at the rest rate on battery, and a signed-out Claude
// Code stops getting warm spares it can only fail with.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');

test('battery saver: breathing states draw at the rest rate, hand-driven and big motions keep the full rate', () => {
  const engine = read('companion/renderer/knot-engine.js');
  assert.match(engine, /const big = !!\(drag \|\| travel \|\| gesture \|\| fileHover \|\| burst \|\| trace\);/);
  assert.match(engine, /fast \? \(lowPower && !big \? IN\.frame\.rest : IN\.frame\.active\) : IN\.frame\.rest/);
  assert.match(engine, /setLowPower\(v\) \{ lowPower = !!v; \}/);
  const main = read('companion/index.js');
  assert.match(main, /battery = !!pm\.isOnBatteryPower\(\)/, 'the power state comes from Electron');
  assert.match(main, /pm\.on\('on-battery', sendPowerState\); pm\.on\('on-ac', sendPowerState\);/, 'and follows plugging in and out');
  assert.match(read('companion/preload.js'), /'power:state'/);
  assert.match(read('companion/renderer/renderer.js'), /nus\.on\('power:state', \(p\) => \{ if \(knot3d && knot3d\.setLowPower\) knot3d\.setLowPower\(!!\(p && p\.battery\)\); \}\);/);
});

test('a signed-out Claude Code gets no warm spares for a while; a real answer clears it', () => {
  const ai = read('src/ai.js');
  assert.match(ai, /if \(poolUnsupported \|\| signedOutResting\(\)\) return false;/);
  assert.match(ai, /result\.error === 'cli_not_logged_in'\) \{[^}]*signedOutAt = Date\.now\(\); \}/);
  assert.match(ai, /else if \(result && !result\.error\) signedOutAt = 0;/);
  assert.equal((ai.match(/noteCliResult\(result\);/g) || []).length, 2, 'both the plain and the streamed answers report');
});
