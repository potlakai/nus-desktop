const { safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');

let secretsDir = null;

function init(userDataDir) {
  secretsDir = path.join(userDataDir, 'secrets');
  fs.mkdirSync(secretsDir, { recursive: true });
}

function isAvailable() {
  return safeStorage && safeStorage.isEncryptionAvailable();
}

function setSecret(key, value) {
  if (!secretsDir) throw new Error('secrets: not initialized');
  if (!isAvailable()) {
    fs.writeFileSync(path.join(secretsDir, `${key}.plain`), String(value), 'utf8');
    return;
  }
  const buf = safeStorage.encryptString(String(value));
  fs.writeFileSync(path.join(secretsDir, `${key}.enc`), buf);
}

function getSecret(key) {
  if (!secretsDir) return null;
  const encPath = path.join(secretsDir, `${key}.enc`);
  const plainPath = path.join(secretsDir, `${key}.plain`);
  if (fs.existsSync(encPath)) {
    if (!isAvailable()) return null;
    return safeStorage.decryptString(fs.readFileSync(encPath));
  }
  if (fs.existsSync(plainPath)) {
    return fs.readFileSync(plainPath, 'utf8');
  }
  return null;
}

function deleteSecret(key) {
  if (!secretsDir) return;
  for (const ext of ['enc', 'plain']) {
    const p = path.join(secretsDir, `${key}.${ext}`);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function listSecrets() {
  if (!secretsDir || !fs.existsSync(secretsDir)) return [];
  return fs.readdirSync(secretsDir).map((f) => f.replace(/\.(enc|plain)$/, ''));
}

module.exports = { init, setSecret, getSecret, deleteSecret, listSecrets, isAvailable };