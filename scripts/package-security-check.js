const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');

const root = path.resolve(__dirname, '..');

// The packed asar sits in a different place per target. An explicit path wins
// (CI passes the mac bundle); otherwise the first unpacked build found is used.
const candidates = process.argv[2]
  ? [path.resolve(process.argv[2])]
  : [
    path.join(root, 'dist', 'win-unpacked', 'resources', 'app.asar'),
    path.join(root, 'dist', 'mac-arm64', 'Nus.app', 'Contents', 'Resources', 'app.asar'),
    path.join(root, 'dist', 'mac', 'Nus.app', 'Contents', 'Resources', 'app.asar'),
  ];
const archive = candidates.find((candidate) => fs.existsSync(candidate));

if (!archive) {
  console.error(JSON.stringify({ ok: false, error: 'packaged_app_missing', looked: candidates.map((c) => path.relative(root, c)) }));
  process.exit(1);
}

const entries = asar.listPackage(archive).map((entry) => entry.replace(/^[/\\]+/, '').replace(/\\/g, '/'));
const forbiddenPaths = entries.filter((entry) =>
  /^(?:docs|scripts|supabase)(?:\/|$)/i.test(entry)
  || /(?:^|\/)\.env(?:\.|$)/i.test(entry)
  || /^(?:src|renderer|companion)\/.*\.test\.js$/i.test(entry)
  || /^(?:deno\.lock|AGENTS\.md)$/i.test(entry)
);

const required = ['src/license.js', 'src/limits.js', 'src/main.js', 'src/ipc-origin.js', 'src/guide-input.js', 'renderer/index.html', 'companion/index.js', 'companion/preload.js', 'companion/renderer/index.html', 'companion/renderer/knot3d.js', 'companion/renderer/quiet-knot.css', 'companion/renderer/strand.js', 'companion/src/guide/session.js', 'companion/src/guide/sensitive.js'];
required.push('companion/src/selected-assistance.js', 'companion/src/inspection-input.js', 'companion/src/companion-context.js', 'src/transcription-queue.js');
const missingPaths = required.filter((entry) => !entries.includes(entry));
const ownedText = entries.filter((entry) =>
  /^(?:src|renderer|companion)\//.test(entry)
  && /\.(?:js|json|html|css|md)$/i.test(entry)
);

const patterns = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g],
  ['stripe_secret', /\bsk_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ['stripe_webhook_secret', /\bwhsec_[A-Za-z0-9]{16,}\b/g],
  ['anthropic_key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai_key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ['google_api_key', /\bAIza[0-9A-Za-z_-]{30,}\b/g],
  ['github_token', /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['aws_access_key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
];
const secretFindings = [];
const unreadablePaths = [];

for (const entry of ownedText) {
  let source;
  try { source = asar.extractFile(archive, path.normalize(entry)).toString('utf8'); }
  catch { unreadablePaths.push(entry); continue; }
  for (const [kind, pattern] of patterns) {
    pattern.lastIndex = 0;
    const count = [...source.matchAll(pattern)].length;
    if (count) secretFindings.push({ file: entry, kind, count });
  }
}

const report = {
  ok: forbiddenPaths.length === 0 && missingPaths.length === 0 && secretFindings.length === 0 && unreadablePaths.length === 0,
  archive: path.relative(root, archive),
  packagedEntries: entries.length,
  ownedTextFilesScanned: ownedText.length - unreadablePaths.length,
  unreadablePaths,
  forbiddenPaths,
  missingPaths,
  secretFindings,
};

if (!report.ok) {
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}
console.log(JSON.stringify(report));
