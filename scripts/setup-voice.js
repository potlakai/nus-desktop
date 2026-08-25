// Downloads the whisper.cpp Windows binary and the base English model for local voice.
// Usage: npm run setup:voice [-- --small]
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const WHISPER_TAG = 'b4938';
const BIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_TAG}/whisper-bin-x64.zip`;
const MODEL_BASE_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en-q5_1.bin';
const MODEL_SMALL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en-q5_1.bin';

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'vendor', 'whisper');
const modelDir = path.join(root, 'vendor', 'whisper-models');

async function download(url, dest) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  console.log(`  saved ${dest} (${(buf.length / 1048576).toFixed(1)} MB)`);
}

function findExe(dir) {
  for (const name of ['whisper-cli.exe', 'main.exe']) {
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name.toLowerCase() === name) return full;
      }
    }
  }
  return null;
}

// Keep only what whisper-cli needs; the zip ships benches, tests and demos.
function prune(dir) {
  const keep = /^(whisper-cli\.exe|main\.exe|.*\.dll)$/i;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
    else if (!keep.test(entry.name)) fs.rmSync(full, { force: true });
  }
}

async function main() {
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.mkdirSync(modelDir, { recursive: true });

  const zipPath = path.join(vendorDir, 'whisper-bin-x64.zip');
  if (!findExe(vendorDir)) {
    await download(BIN_URL, zipPath);
    execFileSync('powershell.exe', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath "${zipPath}" -DestinationPath "${vendorDir}" -Force`,
    ], { stdio: 'inherit' });
    fs.unlinkSync(zipPath);
    // Flatten: some release zips nest binaries in a subfolder.
    const exe = findExe(vendorDir);
    if (exe && path.dirname(exe) !== vendorDir) {
      for (const entry of fs.readdirSync(path.dirname(exe))) {
        fs.renameSync(path.join(path.dirname(exe), entry), path.join(vendorDir, entry));
      }
    }
  }
  prune(vendorDir);
  const exe = findExe(vendorDir);
  if (!exe) throw new Error('whisper binary not found after extract');
  console.log(`Binary ready: ${exe}`);

  const wantSmall = process.argv.includes('--small');
  const modelUrl = wantSmall ? MODEL_SMALL_URL : MODEL_BASE_URL;
  const modelPath = path.join(modelDir, path.basename(new URL(modelUrl).pathname));
  if (!fs.existsSync(modelPath)) await download(modelUrl, modelPath);
  console.log(`Model ready: ${modelPath}`);
  console.log('Voice setup complete.');
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
