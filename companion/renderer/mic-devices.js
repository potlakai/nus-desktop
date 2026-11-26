// Which microphone the Companion listens with (onboard-0120, friend test 2026-11-11: the default
// laptop microphone was not picked up and there was no way to choose another). One list, read by
// the Knot's window (push-to-talk, the tour's microphone card) and the dashboard's Settings, so
// the two always offer the same devices. The choice is two settings: micDeviceId and
// micDeviceLabel. Empty means the Windows default.
//
// Plain data and functions, so the tests run it in Node.
(function (root) {
  'use strict';

  // Chromium on Windows lists two stand-ins beside the real devices: "default" (the Windows
  // default, labelled "Default - <name>") and "communications". Neither is a device of its own.
  const STAND_INS = new Set(['default', 'communications']);
  const strip = (label) => String(label || '').replace(/^(?:Default|Communications)\s*-\s*/i, '').trim();

  // enumerateDevices() rows -> { list: [{ id, label }], defaultLabel }. Labels are empty until
  // the page may use the microphone; those devices are numbered instead.
  function inputs(devices) {
    const rows = (Array.isArray(devices) ? devices : []).filter((d) => d && d.kind === 'audioinput');
    const def = rows.find((d) => d.deviceId === 'default');
    const list = [];
    for (const d of rows) {
      if (STAND_INS.has(d.deviceId) || !d.deviceId || list.some((x) => x.id === d.deviceId)) continue;
      list.push({ id: d.deviceId, label: strip(d.label) || 'Microphone ' + (list.length + 1) });
    }
    let defaultLabel = def ? strip(def.label) : '';
    if (!defaultLabel && list.length) defaultLabel = list[0].label;
    return { list, defaultLabel };
  }

  // The device to open for a saved choice. -> { id, label, why }
  // why: 'default' (nothing chosen), 'saved', 'renamed' (same name, new id: Windows re-ids a
  // device after a driver update or another USB port), 'missing' (chosen, not plugged in: the
  // Windows default stands in, and the choice is kept for when it comes back).
  function choose(found, saved) {
    const s = saved || {}, list = (found && found.list) || [], defaultLabel = (found && found.defaultLabel) || '';
    const id = String(s.micDeviceId || ''), label = String(s.micDeviceLabel || '');
    if (!id) return { id: '', label: defaultLabel, why: 'default' };
    const same = list.find((d) => d.id === id);
    if (same) return { id: same.id, label: same.label, why: 'saved' };
    const named = label && list.find((d) => d.label === label);
    if (named) return { id: named.id, label: named.label, why: 'renamed' };
    return { id: '', label: defaultLabel, why: 'missing', wanted: label };
  }

  // getUserMedia audio constraints for one device ('' is the Windows default).
  function constraints(id) {
    const audio = { echoCancellation: true, noiseSuppression: true, channelCount: 1 };
    if (id) audio.deviceId = { exact: String(id) };
    return { audio };
  }

  // A device came or went. prev and next are inputs() results; open is the device in use (its
  // id, '' for the default, null when no microphone is open). -> { reopen, message, added, removed }
  function react(prev, next, saved, open) {
    const before = (prev && prev.list) || [], after = (next && next.list) || [];
    const added = after.filter((d) => !before.some((b) => b.id === d.id));
    const removed = before.filter((d) => !after.some((a) => a.id === d.id));
    const want = choose(next, saved);
    let reopen = false, message = '';
    if (open !== null && open !== undefined) {
      // The open device went away, or the chosen one came back, or Windows moved its default.
      if (open && !after.some((d) => d.id === open)) reopen = true;
      else if (want.id !== open) reopen = true;
      else if (!open && prev && next && prev.defaultLabel !== next.defaultLabel) reopen = true;
    }
    const chosenGone = saved && saved.micDeviceId && removed.some((d) => d.id === saved.micDeviceId || (saved.micDeviceLabel && d.label === saved.micDeviceLabel));
    if (chosenGone) message = (saved.micDeviceLabel || 'Your microphone') + ' was unplugged. Using ' + (next.defaultLabel || 'the Windows default') + ' for now.';
    else if (want.why === 'saved' || want.why === 'renamed') { if (added.some((d) => d.id === want.id)) message = 'Listening with ' + want.label + ' again.'; }
    else if (added.length === 1) message = 'New microphone: ' + added[0].label + '. To use it, pick it in Settings, Voice, Microphone.';
    else if (added.length > 1) message = added.length + ' new microphones. Pick one in Settings, Voice, Microphone.';
    return { reopen, message, added, removed };
  }

  // The tour's microphone card, after it has listened for a while with no voice heard.
  // peak is the loudest raw level seen (the worklet's RMS). -> '' | 'dead' | 'quiet'
  const LISTEN_MS = 5000, DEAD_PEAK = 0.0005;
  function verdict(elapsedMs, heard, peak) {
    if (heard || elapsedMs < LISTEN_MS) return '';
    return (Number(peak) || 0) < DEAD_PEAK ? 'dead' : 'quiet';
  }
  // The words for that verdict, the device open, and how many others there are.
  function helpLine(kind, label, others) {
    const name = label || 'this microphone';
    if (kind === 'dead') return others ? 'No sound at all from ' + name + '. It may be muted or the wrong one. Pick another below.'
      : 'No sound at all from ' + name + '. Check it is not muted: Windows Settings, System, Sound, Input. Or go on without it and type to me.';
    if (kind === 'quiet') return others ? 'I cannot hear words yet. Speak up, or pick another microphone below.' : 'I cannot hear words yet. Speak up and a little closer.';
    return '';
  }
  // When no microphone opens at all (none plugged in, blocked, or busy).
  function failLine(errName) {
    if (errName === 'NotAllowedError') return 'Windows is blocking the microphone. Allow it in Windows Settings, Privacy, Microphone, then press Try again. Or go on without it and type to me.';
    if (errName === 'NotReadableError') return 'The microphone is busy or did not start. Close other apps using it and press Try again, or pick another.';
    return 'I cannot find a microphone. Plug one in and press Try again. Or go on without it: click me any time and type.';
  }

  const api = { inputs, choose, constraints, react, verdict, helpLine, failLine, LISTEN_MS, DEAD_PEAK };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NusMic = api;
})(typeof window !== 'undefined' ? window : globalThis);
