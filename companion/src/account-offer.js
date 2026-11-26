// When Home offers the optional account (docs/accounts-b.md, ruled
// 2026-10-31): never at first run, only from the third distinct local day the
// Companion was opened, and "Not now" hides the offer for good. The Account
// card in Settings is always there; this only decides the one card on Saved.
// Kept in the preferences table: a count of days, the last day counted, and
// the dismissal. Nothing here leaves the computer.
const OFFER_DAY = 3;

function localDay(t) {
  const d = new Date(t);
  return [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-');
}

// A launch or a Home window on a day not yet counted: the patch to write, or
// null when today is already in.
function countOpen(prefs, now = Date.now()) {
  const day = localDay(now);
  if ((prefs && prefs.account_last_open_day) === day) return null;
  const days = Math.max(0, Number(prefs && prefs.account_open_days) || 0) + 1;
  return { account_open_days: days, account_last_open_day: day };
}

function shouldOffer(prefs, signedIn) {
  if (signedIn || (prefs && prefs.account_offer_dismissed)) return false;
  return (Number(prefs && prefs.account_open_days) || 0) >= OFFER_DAY;
}

module.exports = { OFFER_DAY, countOpen, shouldOffer, localDay };
