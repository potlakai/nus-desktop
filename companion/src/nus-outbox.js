// One-way outbox: copilot -> Nūs desktop brain. Opt-in (reportToNus setting).
// Appends bounded event records to %APPDATA%\Nus\companion-events.json so the
// desktop app can ingest what the overlay saw and answered. Mirror of
// nus-context.js, pointed the other direction.
const fs = require('fs');
const path = require('path');

const MAX_EVENTS = 40;
const MAX_TEXT = 4000;

function outboxFile(appDataDir) {
  return path.join(appDataDir, 'Nus', 'companion-events.json');
}

function appendEvent(appDataDir, event) {
  const file = outboxFile(appDataDir);
  let events = [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && parsed.schema_version === 1 && Array.isArray(parsed.events)) events = parsed.events;
  } catch {}
  events.push({
    ts: new Date().toISOString(),
    mode: String(event.mode || ''),
    used_screenshot: Boolean(event.used_screenshot),
    answer: String(event.answer || '').slice(0, MAX_TEXT),
    transcript_tail: String(event.transcript_tail || '').slice(0, MAX_TEXT),
  });
  if (events.length > MAX_EVENTS) events = events.slice(-MAX_EVENTS);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ schema_version: 1, product: 'Nūs', source: 'companion', events }, null, 2));
    return true;
  } catch {
    return false;
  }
}

module.exports = { appendEvent, outboxFile };
