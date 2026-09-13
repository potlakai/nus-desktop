// Dev check for the Windows probe sidecar (companion/src/win/probe.ps1).
// Read-only: it never clicks, types, or moves anything.
//
//   node scripts/probe-check.js            quick: ping, foreground, controls, point
//   node scripts/probe-check.js --watch 10 also watch clicks/keys/fg for 10 s
//
// Alt-tab to the app you care about while it runs; it prints what it sees.
'use strict';

const { createProbe } = require('../companion/src/win/probe');

const args = process.argv.slice(2);
const watchSecs = args.includes('--watch') ? Number(args[args.indexOf('--watch') + 1] || 10) : 0;
const t0 = Date.now();
const ms = () => String(Date.now() - t0).padStart(6, ' ') + 'ms';

const probe = createProbe({ log: (m) => console.log(ms(), '[probe]', m) });

async function timed(label, fn) {
  const s = Date.now();
  try {
    const r = await fn();
    console.log(ms(), label, '(' + (Date.now() - s) + 'ms)');
    return r;
  } catch (e) {
    console.log(ms(), label, 'FAILED:', e.message);
    return null;
  }
}

async function main() {
  probe.start();
  const ready = await new Promise((resolve) => {
    if (probe.available) return resolve(true);
    const off = probe.on('availability', (v) => { off(); resolve(v); });
    setTimeout(() => resolve(false), 20000);
  });
  console.log(ms(), 'available:', ready, probe.status());
  if (!ready) { probe.stop(); process.exit(1); }

  const fg = await timed('fg', () => probe.request('fg'));
  if (fg) console.log('   foreground:', fg.process, '|', fg.title, '| hwnd', fg.hwnd, '| rect', JSON.stringify(fg.rect));

  const cur = await timed('cursor', () => probe.request('cursor'));
  if (cur) {
    const fp = await timed('uia.frompoint', () => probe.request('uia.frompoint', { x: cur.x, y: cur.y }, 4000));
    if (fp && fp.element) console.log('   under cursor:', fp.element.type, '|', JSON.stringify(fp.element.name), '| rect', JSON.stringify(fp.element.rect), '| pid', fp.element.pid);
    else console.log('   under cursor: nothing');
  }

  if (fg && fg.hwnd) {
    const list = await timed('uia.list', () => probe.request('uia.list', { hwnd: fg.hwnd, max: 150 }, 6000));
    if (list) {
      console.log('   controls:', list.elements.length, '| visited', list.visited, '| truncated', list.truncated, '| walk', list.ms + 'ms');
      for (const e of list.elements.slice(0, 25)) console.log('     ', String(e.id).padStart(3), e.type.padEnd(12), JSON.stringify(e.name).slice(0, 50).padEnd(52), JSON.stringify(e.rect));
      if (list.elements.length > 25) console.log('      ...', list.elements.length - 25, 'more');
      const first = list.elements.find((e) => e.name);
      if (first) {
        const found = await timed('uia.find "' + first.name + '"', () => probe.request('uia.find', { hwnd: fg.hwnd, name: first.name, type: first.type }, 6000));
        if (found && found.element) console.log('   found:', found.element.type, JSON.stringify(found.element.name), 'score', found.score, 'rect', JSON.stringify(found.element.rect));
      }
    }
  }

  if (watchSecs > 0) {
    console.log(ms(), 'watching clicks, Esc, and foreground changes for', watchSecs, 's...');
    probe.on('event', (ev) => { if (ev.ev !== 'ready') console.log(ms(), 'event', JSON.stringify(ev).slice(0, 200)); });
    await probe.watch({ keys: [27], click: true, fg: true });
    await new Promise((r) => setTimeout(r, watchSecs * 1000));
    await probe.unwatch();
  }

  probe.stop();
  console.log(ms(), 'done');
}

main().catch((e) => { console.error(e); probe.stop(); process.exit(1); });
