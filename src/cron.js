'use strict';
// Five-field cron, and the one question the scheduler asks: when is this due
// next?
//
//   minute hour day-of-month month day-of-week
//
// The desktop's automations already tick every minute (runDueAutomations in
// main.js) and already store a next_run_at per row, so this is an extension of
// that tick, not a second scheduler. What was missing is a trigger whose next
// run is a real time rather than "tomorrow" or "in seven days".
//
// Deliberately not a full cron: no @aliases, no seconds, no L/W/# modifiers, and
// no timezone field, because the row's own trigger_json carries the timezone the
// schedule was made in. It handles the ranges, lists and steps people actually
// type, refuses anything else with a sentence that says what is wrong, and never
// returns a time in the past.
//
// Day-of-week is 0-7 with both 0 and 7 as Sunday, as vixie cron does. The
// classic quirk is kept on purpose: when BOTH day-of-month and day-of-week are
// restricted (neither is '*'), a day matches if EITHER does.

const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

const FIELDS = [
  { key: 'minute', min: 0, max: 59, label: 'minute' },
  { key: 'hour', min: 0, max: 23, label: 'hour' },
  { key: 'dom', min: 1, max: 31, label: 'day of the month' },
  { key: 'month', min: 1, max: 12, label: 'month', names: MONTH_NAMES, namedBase: 1 },
  { key: 'dow', min: 0, max: 7, label: 'day of the week', names: DOW_NAMES },
];

class CronError extends Error {
  constructor(message, field) { super(message); this.name = 'CronError'; this.field = field || null; }
}

// Month names are 1-based ("jan" is month 1), weekday names are 0-based
// ("sun" is day 0). Saying so at the table stops the off-by-one before it lands.
// "1-5" | "*" | "3" | "*/10" | "1,15,30" | "mon-fri" -> sorted numbers.
function parseField(text, spec) {
  const raw = String(text == null ? '' : text).trim().toLowerCase();
  if (!raw) throw new CronError('The ' + spec.label + ' is empty.', spec.key);
  const out = new Set();
  for (const part of raw.split(',')) {
    if (!part) throw new CronError('The ' + spec.label + ' has an empty item (a stray comma).', spec.key);
    const [rangeText, stepText] = part.split('/');
    if (stepText !== undefined && !/^\d+$/.test(stepText)) throw new CronError('"' + part + '" is not a step like */5.', spec.key);
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) throw new CronError('A step must be at least 1, not ' + stepText + '.', spec.key);
    let from, to;
    if (rangeText === '*') { from = spec.min; to = spec.max; } else if (rangeText.includes('-')) {
      const bits = rangeText.split('-');
      if (bits.length !== 2) throw new CronError('"' + part + '" is not a range like 1-5.', spec.key);
      from = valueOf(bits[0], spec, part);
      to = valueOf(bits[1], spec, part);
      if (from > to) throw new CronError('The ' + spec.label + ' range "' + part + '" runs backwards.', spec.key);
    } else {
      from = valueOf(rangeText, spec, part);
      to = stepText === undefined ? from : spec.max;
    }
    for (let v = from; v <= to; v += step) out.add(v);
  }
  if (!out.size) throw new CronError('The ' + spec.label + ' matches nothing.', spec.key);
  return [...out].sort((a, b) => a - b);
}

function valueOf(token, spec, part) {
  const t = String(token || '').trim().toLowerCase();
  if (spec.names) {
    const at = spec.names.indexOf(t);
    // A name maps through its own table's base: months are 1-12, weekdays 0-6.
    if (at >= 0) return at + (spec.namedBase || 0);
  }
  if (!/^\d+$/.test(t)) throw new CronError('"' + t + '" in "' + part + '" is not a number or a name for the ' + spec.label + '.', spec.key);
  const v = Number(t);
  if (v < spec.min || v > spec.max) throw new CronError('The ' + spec.label + ' must be ' + spec.min + ' to ' + spec.max + ', not ' + v + '.', spec.key);
  return v;
}

/**
 * Parse five fields. Throws CronError with a sentence for the person.
 * -> { minutes, hours, doms, months, dows, domRestricted, dowRestricted }
 */
function parse(expression) {
  const text = String(expression == null ? '' : expression).trim().replace(/\s+/g, ' ');
  if (!text) throw new CronError('The schedule is empty. Write five fields, like 0 9 * * 1-5.');
  const parts = text.split(' ');
  if (parts.length !== 5) throw new CronError('A schedule has five fields (minute hour day month weekday); this has ' + parts.length + '. Example: 0 9 * * 1-5');
  const [minute, hour, dom, month, dow] = parts;
  const minutes = parseField(minute, FIELDS[0]);
  const hours = parseField(hour, FIELDS[1]);
  const doms = parseField(dom, FIELDS[2]);
  const months = parseField(month, FIELDS[3]);
  const dowsRaw = parseField(dow, FIELDS[4]);
  // 7 is Sunday too; fold it onto 0 so matching needs one comparison.
  const dows = [...new Set(dowsRaw.map((d) => (d === 7 ? 0 : d)))].sort((a, b) => a - b);
  return {
    expression: text, minutes, hours, doms, months, dows,
    domRestricted: dom.trim() !== '*', dowRestricted: dow.trim() !== '*',
  };
}

function matchesDay(spec, date) {
  if (!spec.months.includes(date.getMonth() + 1)) return false;
  const domOk = spec.doms.includes(date.getDate());
  const dowOk = spec.dows.includes(date.getDay());
  // The vixie rule: both restricted means either may match.
  if (spec.domRestricted && spec.dowRestricted) return domOk || dowOk;
  if (spec.domRestricted) return domOk;
  if (spec.dowRestricted) return dowOk;
  return true;
}

/**
 * The first time on or after `from` that the expression fires.
 * `from` is used as-is (local time); the result is a Date.
 * Returns null when nothing matches within the search window (a 31 February).
 */
function nextAfter(expression, from = new Date()) {
  const spec = typeof expression === 'string' ? parse(expression) : expression;
  const start = new Date(from.getTime());
  if (!Number.isFinite(start.getTime())) throw new CronError('nextAfter needs a real date to start from.');
  // Start on the next whole minute: a run at 09:00:00 exactly is due, 09:00:01
  // is not the same minute any more.
  const t = new Date(start.getTime());
  t.setSeconds(0, 0);
  if (t.getTime() < start.getTime()) t.setMinutes(t.getMinutes() + 1);
  // Five years of days is far past any real schedule; February 30 never lands.
  for (let day = 0; day < 366 * 5; day++) {
    const d = new Date(t.getTime());
    d.setDate(d.getDate() + day);
    if (!matchesDay(spec, d)) continue;
    for (const h of spec.hours) {
      for (const m of spec.minutes) {
        const at = new Date(d.getTime());
        at.setHours(h, m, 0, 0);
        if (at.getTime() >= t.getTime()) return at;
      }
    }
  }
  return null;
}

// Is this expression due at `now`? True only within the minute it names, so a
// tick that runs twice in the same minute cannot run the job twice.
function isDue(expression, now = new Date()) {
  const spec = typeof expression === 'string' ? parse(expression) : expression;
  return spec.minutes.includes(now.getMinutes()) && spec.hours.includes(now.getHours()) && matchesDay(spec, now);
}

// For the row's next_run_at column, as the tick already stores it.
function nextRunIso(expression, from = new Date()) {
  const next = nextAfter(expression, from);
  return next ? next.toISOString() : null;
}

// One sentence a person can read, for the row and the card.
function describe(expression) {
  const spec = typeof expression === 'string' ? parse(expression) : expression;
  const list = (arr) => arr.join(', ');
  const time = spec.minutes.length === 1 && spec.hours.length === 1
    ? String(spec.hours[0]).padStart(2, '0') + ':' + String(spec.minutes[0]).padStart(2, '0')
    : 'minute ' + list(spec.minutes) + ' of hour ' + list(spec.hours);
  const days = [];
  if (spec.dowRestricted) days.push(DOW_NAMES.filter((_, i) => spec.dows.includes(i)).join(', ') || list(spec.dows));
  if (spec.domRestricted) days.push('day ' + list(spec.doms) + ' of the month');
  if (spec.months.length !== 12) days.push('in ' + spec.months.map((m) => MONTH_NAMES[m - 1]).join(', '));
  return 'At ' + time + (days.length ? ', on ' + days.join('; ') : ', every day') + '.';
}

module.exports = { parse, parseField, nextAfter, nextRunIso, isDue, describe, CronError, FIELDS, DOW_NAMES, MONTH_NAMES };
