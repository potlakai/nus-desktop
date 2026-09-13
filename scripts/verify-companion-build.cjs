// A package can pass a smoke test yet still be older than the working tree.
// Verify bytes, including the separately executed Windows probe, before handoff.
const fs = require('node:fs');
const path = require('node:path');
const asar = require('@electron/asar');
const root = path.resolve(__dirname, '..');
const archive = path.resolve(process.argv[2] || 'dist/win-unpacked/resources/app.asar');
const required = ['companion/index.js', 'companion/src/inspection-input.js', 'companion/src/selected-assistance.js', 'companion/renderer/renderer.js', 'companion/renderer/strand.js', 'companion/renderer/quiet-knot.css', 'companion/preload.js'];
const entries = asar.listPackage(archive).map(p => p.replace(/^[/\\]+/, '').replace(/\\/g, '/'));
const files = entries.filter(p => /^(src|renderer|companion)\//.test(p) && fs.existsSync(path.join(root, p)) && fs.statSync(path.join(root, p)).isFile());
const mismatches = required.filter(p => !entries.includes(p)).map(p => p + ' (missing)');
for (const file of files) {
  if (!fs.readFileSync(path.join(root, file)).equals(asar.extractFile(archive, path.normalize(file)))) mismatches.push(file);
}
const externalProbe = path.join(path.dirname(archive), 'win/probe.ps1');
const probeMatches = fs.existsSync(externalProbe) && fs.readFileSync(externalProbe).equals(fs.readFileSync(path.join(root, 'companion/src/win/probe.ps1')));
if (!probeMatches) mismatches.push('resources/win/probe.ps1');
console.log(JSON.stringify({ ok: mismatches.length === 0, archive, sourceFilesCompared: files.length, probeMatches, mismatches }));
if (mismatches.length) process.exitCode = 1;
