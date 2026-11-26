// Personal build: there are no plans, so there are no caps.
//
// Upstream shipped a free tier (3 syllabus imports, 10 questions a day, one
// connected account, one automation, 20 minutes of Companion a day, 7 days of
// history, 512 MB of storage) and sold Pro to lift it. This build is for one
// person on one machine, so every gate answers "yes" and every counter is a
// no-op that keeps no state.
//
// The module keeps its upstream shape on purpose: main.js calls these methods
// from 20 sites, and the renderer reads summary(). Returning the same shapes
// with the caps removed means no call site has to know the plans are gone.
//
// Limits this module does NOT own, because they are not commercial:
//   - asking for consent before a risky desktop action (companion/src/hands)
//   - refusing passwords, card numbers and captchas (companion/src/hands)
//   - the storage check that stops a corrupt write (src/db.js)

// Kept for the tests that pin the upstream vocabulary; nothing enforces them.
const FREE_LIMITS = Object.freeze({
  syllabusImports: Infinity,
  questionsPerDay: Infinity,
  connectedAccounts: Infinity,
  automationRules: Infinity,
  companionMsPerDay: Infinity,
  historyDays: Infinity,
  storageBytes: Infinity,
});

// The cap the database uses for its own growth check. Not a paywall: one number
// large enough that this machine hits disk space long before it hits this.
const PRO_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

function localDay(timestamp) {
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function createLimits() {
  // Every "may I" is yes, in the shape the caller expects ({ ok: true }).
  const allowed = () => ({ ok: true });

  return {
    syllabusAllowed: allowed,
    recordSyllabus() {},
    // reserveQuestion used to hand back a ticket that a later call spent. There
    // is nothing to spend now, so it hands back an always-valid ticket.
    reserveQuestion() { return { ok: true, ticket: null }; },
    connectedAccountAllowed: allowed,
    automationAllowed: allowed,
    // The Companion checks this before it starts listening. Infinity means the
    // no-limit path in companion/index.js setCapturing(): no timer is armed.
    companionAllowanceMs() { return Number.POSITIVE_INFINITY; },
    recordCompanionMs() {},
    // History is never cut off.
    historyCutoff() { return null; },
    storageCapBytes() { return PRO_STORAGE_BYTES; },
    summary() {
      return {
        plan: 'personal',
        syllabusImports: { used: 0, limit: null },
        questions: { used: 0, limit: null },
        companionMs: { used: 0, limit: null },
        historyDays: null,
        storageBytes: PRO_STORAGE_BYTES,
      };
    },
  };
}

module.exports = { createLimits, FREE_LIMITS, PRO_STORAGE_BYTES, localDay };
