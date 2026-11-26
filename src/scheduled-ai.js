'use strict';
// Scheduled AI work: an automation row whose action is "ask J.A.R.V.I.S to do
// this", fired by the tick that already runs the task automations.
//
// The scheduler is not new. runDueAutomations() in main.js has fired due rows
// every minute since the task automations shipped, and its rows already carry
// next_run_at. What this adds is one more action_type, 'ask_ai', and the cron
// expression that makes its next run a real time rather than "tomorrow".
//
// Pure on purpose: it takes the run function and the clock, so the tick's
// behaviour can be tested without an app, a screen or a model.
//
// The rule that matters most is the operator's: an unattended run may read, open
// and look, but it may never approve a consent card on the operator's behalf.
// That is enforced twice, here (the run is told it is unattended) and in
// hands/agent.js (a card that needs an answer stops the run).

const { nextRunIso, isDue, parse, CronError } = require('./cron');

const ACTION = 'ask_ai';
// A minute of slack: the tick runs every 60 s and can be a second late, so a row
// due at 09:00 must not be skipped because the tick arrived at 09:00:04.
const LATE_MS = 90 * 1000;

/**
 * Which rows are due right now, from the rows the database returned.
 * db.dueAutomations already filters on next_run_at <= now and enabled = 1, so
 * this is the second, stricter pass: a row whose next_run_at is far in the past
 * (the machine was asleep for a week) fires once, not eleven times.
 * -> [{ row, ask, late }]
 */
function dueRows(rows, now = new Date()) {
  const out = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.action_type !== ACTION) continue;
    if (row.enabled === 0) continue;
    let action;
    try { action = typeof row.action_json === 'string' ? JSON.parse(row.action_json) : (row.action_json || {}); } catch { continue; }
    const ask = String(action.ask || action.prompt || '').trim();
    if (!ask) continue;
    const at = row.next_run_at ? new Date(row.next_run_at) : null;
    const late = at ? now.getTime() - at.getTime() : 0;
    out.push({ row, ask: ask.slice(0, 2000), late, action });
  }
  return out;
}

/**
 * The next time this row should run, or null when its trigger is not a cron.
 * A cron row keeps its expression in action_json.cron or trigger_json.cron.
 */
function nextFor(row, now = new Date()) {
  let trigger = {}, action = {};
  try { trigger = typeof row.trigger_json === 'string' ? JSON.parse(row.trigger_json) : (row.trigger_json || {}); } catch { /* none */ }
  try { action = typeof row.action_json === 'string' ? JSON.parse(row.action_json) : (row.action_json || {}); } catch { /* none */ }
  const expr = String(action.cron || trigger.cron || '').trim();
  if (expr) {
    try { return nextRunIso(expr, now); } catch (e) { if (e instanceof CronError) return null; throw e; }
  }
  return null;
}

// A person's sentence for the row: "At 09:00, on mon, tue, wed, thu, fri."
function scheduleText(row) {
  let trigger = {}, action = {};
  try { trigger = JSON.parse(row.trigger_json || '{}'); } catch { /* none */ }
  try { action = JSON.parse(row.action_json || '{}'); } catch { /* none */ }
  const expr = String(action.cron || trigger.cron || '').trim();
  if (!expr) return row.trigger_type === 'daily' ? 'Every day.' : row.trigger_type === 'weekly' ? 'Every week.' : 'No schedule.';
  try { return require('./cron').describe(expr); } catch { return expr; }
}

/**
 * Make the runner the tick calls. Injected: run(ask, { row, late, unattended })
 * -> Promise<{ ok, summary }>. Never throws: one bad row must not stop the tick
 * or the other rows.
 */
function createScheduler({ run, log = () => {}, now = () => new Date(), markRun = () => {} } = {}) {
  if (typeof run !== 'function') throw new Error('createScheduler needs a run function.');

  // One run at a time. A scheduled ask can take minutes; the next tick must not
  // start a second copy of it, or a second copy of a different one, and collide
  // on the screen.
  let busy = null;
  const results = [];

  async function tick(rows) {
    if (busy) return { skipped: 'still running', due: 0 };
    const due = dueRows(rows, now());
    if (!due.length) return { ran: 0, due: 0 };
    const ran = [];
    busy = due[0].row.id;
    try {
      for (const item of due) {
        const startedAt = now();
        let result;
        try {
          result = await run(item.ask, { row: item.row, late: item.late, unattended: true });
        } catch (e) {
          result = { ok: false, summary: 'failed: ' + String(e && e.message || e).slice(0, 200) };
        }
        const summary = String((result && result.summary) || '').slice(0, 500);
        const ok = !!(result && result.ok);
        // The clock comes from the finish, not the start: a long run must not
        // schedule the next one in the past.
        const next = nextFor(item.row, now());
        try { markRun(item.row.id, startedAt.toISOString(), next); } catch (e) { log('markRun failed: ' + e.message); }
        const rec = { id: item.row.id, name: item.row.name, at: startedAt.toISOString(), ok, summary, unattended: true, next };
        results.push(rec);
        if (results.length > 50) results.shift();
        log('scheduled "' + (item.row.name || item.row.id) + '" ' + (ok ? 'done' : 'failed') + ': ' + summary);
        ran.push(rec);
      }
    } finally { busy = null; }
    return { ran: ran.length, due: due.length, results: ran };
  }

  return {
    tick,
    get running() { return busy; },
    recent: () => results.slice(-20),
  };
}

module.exports = { createScheduler, dueRows, nextFor, scheduleText, ACTION, LATE_MS };
