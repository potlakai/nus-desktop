const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const ignored = new Set(['.git', 'dist', 'node_modules']);
const textExtensions = new Set(['.js', '.ts', '.json', '.md', '.html', '.css', '.toml', '.sql', '.yml', '.yaml']);
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

const findings = [];

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(target); continue; }
    if (!textExtensions.has(path.extname(entry.name).toLowerCase())) continue;
    let source;
    try { source = fs.readFileSync(target, 'utf8'); } catch { continue; }
    for (const [kind, pattern] of patterns) {
      pattern.lastIndex = 0;
      const count = [...source.matchAll(pattern)].length;
      if (count) findings.push({ file: path.relative(root, target), kind, count });
    }
  }
}

walk(root);
if (findings.length) {
  console.error(JSON.stringify({ ok: false, findings }, null, 2));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, scannedRoot: path.basename(root), secretFindings: 0 }));
