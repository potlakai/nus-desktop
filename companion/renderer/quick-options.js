// The quick options: one list, read by the pill's menu and the dashboard's row,
// so the two can never offer different things. Each option names the setting it
// shows and the patch that changes it; both windows write through the settings
// doors that already exist, and main tells the other window (settings:changed,
// home:settings). There is no store here.
//
// Plain data and functions, so the tests run it in Node.
(function (root) {
  'use strict';

  // Where the Knot lives: the first control in both places, one tap each way.
  const HOME = { id: 'home', key: 'knotIsland', choices: [{ label: 'Free', value: false }, { label: 'Island', value: true }] };

  const SWITCHES = [
    { id: 'hands', key: 'hands', label: 'Hands', on: (s) => s.hands === true },
    { id: 'tasks', key: 'tasks', label: 'Task list', on: (s) => s.tasks === true },
    // Same reading as main's captureHidden(): only an explicit false is off.
    { id: 'hide', key: 'hideFromCapture', label: 'Hide from sharing', on: (s) => s.hideFromCapture !== false },
    { id: 'sounds', key: 'sounds', label: 'Sound cues', on: (s) => s.sounds !== false },
    { id: 'openMic', key: 'openMic', label: 'Open mic', on: (s) => s.openMic === true },
    // The dashboard alone: turning it on may need a 350 MB download, which
    // belongs where its progress is shown.
    { id: 'voice', key: 'voice', label: 'Fable voice', dashboardOnly: true, on: (s) => s.voice != null && s.voice !== 'system', patch: (on) => ({ voice: on ? 'fable' : 'system' }) },
  ];

  function switchesFor(where) { return SWITCHES.filter((o) => where === 'dashboard' || !o.dashboardOnly); }
  function isIsland(settings) { return !!(settings && settings.knotIsland === true); }
  function isOn(option, settings) { return !!option.on(settings || {}); }
  function patchFor(option, on) { return option.patch ? option.patch(!!on) : { [option.key]: !!on }; }
  function homePatch(island) { return { [HOME.key]: !!island }; }

  const api = { HOME, SWITCHES, switchesFor, isIsland, isOn, patchFor, homePatch };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NusQuickOptions = api;
})(typeof window !== 'undefined' ? window : globalThis);
