// The Mac's words (a tester's rounds 1 and 3, 2026-11-15/16: Windows words, keys and steps shown on
// a Mac). Most of the text is written once, for Windows; on a Mac this rewrites the Windows-only
// phrases into what the Mac build actually does, in three places from this one list:
//   - the dashboard and the Knot's overlay (as text appears: a <script> in each page), which also
//     hides the Settings rows a Mac cannot use (Start with Windows, Hands, the task list, the
//     focus guard);
//   - the main process (require), for the bubbles, hints, tour cards and spoken lines it sends
//     (companion/index.js send), and the app guide the model reads.
// On Windows it does nothing at all.
//
// The keys on a Mac (companion/index.js registerShortcuts and PTT_FALLBACKS): show or hide, hide
// now, and select-and-ask are Control+Shift (Space, X, T); the talk key is Control+Option+Space;
// CommandOrControl is Command. The tray is the Nūs icon in the menu bar.
(function (root) {
  const SWAPS = [
    [/Ctrl\+Alt held together is the default\. Typed chords also work: Ctrl\+Alt\+Space, Ctrl\+Shift\+M, Alt\+Shift\+Space, Ctrl\+Alt\+M\./g, 'On a Mac the default is Control+Option+Space: hold it to talk, let go to send. Typed chords also work: Control+Option+K, Command+Shift+M.'],
    [/\bCtrl\+Alt\+Space\b/g, 'Control+Option+Space'],
    [/\bCtrl\+Shift\+(Space|X|T)\b/g, 'Control+Shift+$1'],
    [/\bCtrl\+Alt\b/g, 'Control+Option'],
    [/Windows Settings > Privacy > Microphone/g, 'System Settings > Privacy & Security > Microphone'],
    [/Windows Settings, Privacy, Microphone/g, 'System Settings, Privacy & Security, Microphone'],
    [/Windows Settings, System, Sound, Input/g, 'System Settings, Sound, Input'],
    [/Windows is blocking/g, 'macOS is blocking'],
    [/Check Windows capture permissions and try again\./g, 'Allow Screen Recording for Nus Companion in System Settings, Privacy & Security, then try again.'],
    [/the Windows voice/g, 'the Mac voice'],
    [/The Windows voice/g, 'The Mac voice'],
    [/The Windows default/g, 'The Mac default'],
    [/the Windows default/g, 'the Mac default'],
    [/Windows default/g, 'Mac default'],
    [/Windows version/g, 'macOS version'],
    [/Asks Windows/g, 'Asks macOS'],
    [/asks Windows/g, 'asks macOS'],
    [/your PC/g, 'your Mac'],
    [/this PC/g, 'this Mac'],
    [/\bthe tray icon\b/g, 'the Nūs icon in the menu bar'],
    [/\bThe tray icon\b/g, 'The Nūs icon in the menu bar'],
    [/\bthe tray\b/g, 'the Nūs icon in the menu bar'],
    [/\bThe tray\b/g, 'The Nūs icon in the menu bar'],
    [/\btray icon\b/g, 'menu bar icon'],
  ];
  // Cheap first look: text with none of these has nothing to swap.
  const MAYBE = /Windows|Ctrl|PC\b|tray/;
  function macText(t) {
    const s = String(t);
    if (!MAYBE.test(s)) return s;
    let out = s;
    for (const [a, b] of SWAPS) out = out.replace(a, b);
    return out;
  }
  // The main process's messages: the words in them, nothing else (ids, urls and numbers stay).
  const TEXT_KEYS = new Set(['text', 'kicker', 'status', 'message', 'title', 'body', 'hint', 'spoken', 'speak', 'label', 'line', 'note', 'sub', 'say', 'detail', 'error', 'lead']);
  function uiText(data, depth = 0) {
    if (!data || typeof data !== 'object' || depth > 4) return data;
    if (Array.isArray(data)) { let changed = false; const out = data.map((v) => { const w = uiText(v, depth + 1); if (w !== v) changed = true; return w; }); return changed ? out : data; }
    let out = data;
    for (const [k, v] of Object.entries(data)) {
      let w = v;
      if (typeof v === 'string') { if (TEXT_KEYS.has(k)) w = macText(v); }
      else if (v && typeof v === 'object') w = uiText(v, depth + 1);
      if (w !== v) { if (out === data) out = { ...data }; out[k] = w; }
    }
    return out;
  }

  if (typeof module === 'object' && module.exports) {
    module.exports = { SWAPS, macText, uiText };
    return;
  }

  const nav = (typeof navigator !== 'undefined' && navigator) || {};
  const MAC = /Mac/.test(nav.platform || '') || /Mac OS X/.test(nav.userAgent || '');
  const api = { mac: MAC, text: (t) => (MAC ? macText(t) : t) };
  root.NusMacWords = api;
  if (!MAC) return;
  const fixNode = (n) => { if (n.nodeValue && MAYBE.test(n.nodeValue)) { const v = macText(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; } };
  function fixTree(el) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) fixNode(n);
  }
  function hideRow(id) {
    const box = document.getElementById(id); if (!box) return;
    const row = box.closest('label') || box; row.hidden = true; row.style.display = 'none';
    // The "More" note that follows a row explains that row only.
    const next = row.nextElementSibling; if (next && next.matches('details.more')) { next.hidden = true; next.style.display = 'none'; }
  }
  function start() {
    document.documentElement.classList.add('mac');
    fixTree(document.body);
    for (const id of ['start-with-windows', 'hands', 'tasks', 'focus-guard']) hideRow(id);
    const ptt = document.getElementById('ptt-input'); if (ptt) ptt.placeholder = 'Control+Option+Space';
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'characterData') fixNode(m.target);
        else for (const n of m.addedNodes) { if (n.nodeType === 3) fixNode(n); else if (n.nodeType === 1) fixTree(n); }
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : globalThis);
