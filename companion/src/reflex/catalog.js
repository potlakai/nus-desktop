// The list of apps Jev may choose from. Built once at startup from the Start
// menu (Get-StartApps through the hot probe, so Store apps like Notepad are in
// it too). An app that is not in this list cannot be opened by voice: the
// model can only pick what it is shown.
const MAX_APPS = 200;

// Spoken names people actually use. Matched against the Start menu name.
const ALIASES = [
  [/^notepad$/i, 'notepad, note pad, notes, the notes app, a text editor'],
  [/^(google )?chrome$/i, 'chrome, google chrome, the browser'],
  [/^microsoft edge$/i, 'edge, microsoft edge, the browser'],
  [/^(mozilla )?firefox$/i, 'firefox'],
  [/^arc$/i, 'arc, the arc browser'],
  [/^visual studio code$/i, 'vs code, visual studio code, code editor'],
  [/^file explorer$/i, 'files, file explorer, my files, explorer'],
  [/^settings$/i, 'settings, windows settings'],
  [/^calculator$/i, 'calculator'],
  [/^camera$/i, 'camera, take a photo, photo booth'],
  [/^spotify$/i, 'spotify, music'],
  [/^excel$/i, 'excel, spreadsheet'],
  [/^word$/i, 'word, microsoft word, a document'],
  [/^powerpoint$/i, 'powerpoint, slides'],
  [/^onenote/i, 'onenote, notebook'],
  [/^outlook/i, 'outlook, email, mail'],
  [/^(windows )?terminal$/i, 'terminal, command line, powershell'],
  [/^discord$/i, 'discord'],
  [/^slack$/i, 'slack'],
  [/^obs studio/i, 'obs, recording'],
  [/^snipping tool$/i, 'snipping tool, snip'],
  [/^paint$/i, 'paint'],
  [/^clock$/i, 'clock, timer, alarm'],
  [/^sticky notes$/i, 'sticky notes, stickies'],
  [/^task manager$/i, 'task manager'],
  [/^n[uū]s$/i, 'nus, noose, the nus app, my dashboard']
];

const JUNK = /uninstall|readme|release notes|documentation|\bhelp\b|license|website|\.url$|\bmanual\b|repair|\bsetup\b|installer|updater|crash|diagnos|telemetry|sample|debugg|\(x86\)|command prompt for|developer (command|powershell)|odbc|iscsi|component services|registry|recovery drive|steps recorder|character map|windows fax|wordpad|math input|print management|resource monitor|system (configuration|information)|event viewer|performance monitor|memory diagnostic|services$|local security|disk cleanup|defragment/i;

function keyFor(name, used) {
  let k = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'app';
  let base = k; let n = 2;
  while (used.has(k) || k === 'none') k = base + '_' + (n++);
  used.add(k);
  return k;
}

function buildCatalog(startApps) {
  const used = new Set();
  const seen = new Set();
  const apps = [];
  const ranked = (startApps || []).filter((a) => a && a.name && a.appId && !JUNK.test(a.name));
  // Aliased apps first so the cap never drops the ones people say out loud.
  ranked.sort((a, b) => Number(hasAlias(b.name)) - Number(hasAlias(a.name)));
  for (const a of ranked) {
    const lower = a.name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    const alias = ALIASES.find(([re]) => re.test(a.name));
    apps.push({ key: keyFor(a.name, used), name: a.name, appId: a.appId, describe: alias ? a.name + ' (' + alias[1] + ')' : a.name });
    if (apps.length >= MAX_APPS) break;
  }
  return apps;
}

function hasAlias(name) { return ALIASES.some(([re]) => re.test(name)); }

async function loadCatalog(probe, log) {
  try {
    const r = await probe.request('apps.list', {}, 8000);
    const apps = buildCatalog(r && r.apps);
    if (log) log('[reflex] catalog: ' + apps.length + ' apps (' + ((r && r.apps) || []).length + ' in Start)');
    return apps;
  } catch (e) {
    if (log) log('[reflex] catalog failed: ' + e.message);
    return [];
  }
}

module.exports = { buildCatalog, loadCatalog, MAX_APPS };
