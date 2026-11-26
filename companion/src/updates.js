'use strict';
// Is there a newer Companion? Once a day, one request to GitHub's releases
// list (nothing about the person in it), looking for the newest
// `companion-v*` tag. Companion builds are published as pre-releases under
// the Desktop repo, so the "latest release" endpoint can never answer this;
// the list is read instead. The result is kept in settings so the Home window
// can show it without asking again. Nothing downloads by itself: the button
// opens the release page in the browser, or runs the one-click update when the
// signed channel file (channel.js) names an installer for that version. When the
// channel file answered today, adopt() fills this in and GitHub is not asked.
const REPO = 'potlakai/nus-desktop';
const LIST_URL = 'https://api.github.com/repos/' + REPO + '/releases?per_page=20';
const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases';
const TAG_RE = /^companion-v(\d+)\.(\d+)\.(\d+)$/;
const DAY_MS = 86400000;
const TIMEOUT_MS = 8000;

function parse(version) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(version || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function newer(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

// releases: the GitHub list. -> { version, tag, url, notes } for the newest Companion tag, or null.
function newestCompanion(releases) {
  let best = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    const m = TAG_RE.exec(String(r && r.tag_name || ''));
    if (!m || r.draft) continue;
    const version = m[1] + '.' + m[2] + '.' + m[3];
    if (!best || newer(version, best.version)) best = { version, tag: r.tag_name, url: r.html_url || RELEASES_PAGE + '/tag/' + r.tag_name, notes: String(r.body || '').slice(0, 2000), publishedAt: r.published_at || null };
  }
  return best;
}

// current: this build's version. store: { get, set } over settings. fetchImpl for tests.
function createUpdateCheck({ current, store, fetchImpl = global.fetch, now = () => Date.now(), log = () => {} }) {
  function state() {
    const s = (store.get && store.get('updateCheck')) || {};
    const available = s.version && newer(s.version, current) ? { version: s.version, url: s.url, publishedAt: s.publishedAt } : null;
    return { current, checkedAt: s.checkedAt || null, available, dismissed: s.dismissed === s.version };
  }

  async function check(force = false) {
    const s = (store.get && store.get('updateCheck')) || {};
    if (!force && s.checkedAt && now() - s.checkedAt < DAY_MS) return state();
    try {
      const res = await fetchImpl(LIST_URL, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'nus-companion/' + current }, signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(TIMEOUT_MS) : undefined });
      if (!res.ok) throw new Error('github ' + res.status);
      const best = newestCompanion(await res.json());
      const next = { checkedAt: now(), version: best ? best.version : null, url: best ? best.url : null, publishedAt: best ? best.publishedAt : null, dismissed: s.dismissed || null };
      store.set('updateCheck', next);
      if (best && newer(best.version, current)) log('newer Companion available: ' + best.version + ' (this is ' + current + ')');
    } catch (e) {
      log('update check failed: ' + e.message);
      store.set('updateCheck', { ...s, checkedAt: now() });   // try again tomorrow, not every minute
    }
    return state();
  }

  // The signed channel file answered: its word stands for today.
  function adopt(info) {
    const s = (store.get && store.get('updateCheck')) || {};
    store.set('updateCheck', { checkedAt: now(), version: info && info.version || null, url: info && info.url || RELEASES_PAGE, publishedAt: null, dismissed: s.dismissed || null });
    return state();
  }

  function dismiss() { const s = (store.get && store.get('updateCheck')) || {}; store.set('updateCheck', { ...s, dismissed: s.version || null }); return state(); }

  return { check, state, dismiss, adopt, RELEASES_PAGE };
}

module.exports = { createUpdateCheck, newestCompanion, newer, parse, RELEASES_PAGE, LIST_URL };
