// A save that cannot reach the disk must never take the app down with it.
//
// The in-memory database is still the correct, complete copy in every one of
// these failure cases, so an unguarded throw out of the save timer was the one
// response guaranteed to lose the user's work. These tests hold that line: no
// throw, a classified and reported failure, retries, and a clean recovery once
// the disk problem goes away.
//
// No Electron needed; db.js is plain node.
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { open, api, setSaveStateListener } = require('./db');

const PERSIST_DELAY_MS = 100;
const settle = (ms) => new Promise((r) => setTimeout(r, ms));

// Break writes the way a full disk does: fail the temp-file write that
// atomicReplace performs, with the real errno the OS would raise.
function breakDisk(code) {
  const realOpenSync = fs.openSync;
  fs.openSync = (target, ...rest) => {
    if (String(target).includes('nus.db')) {
      const error = new Error('simulated ' + code);
      error.code = code;
      throw error;
    }
    return realOpenSync(target, ...rest);
  };
  return () => { fs.openSync = realOpenSync; };
}

test('a failing save reports instead of throwing, then recovers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-savefail-'));
  await open(dir);

  const seen = [];
  setSaveStateListener((state) => seen.push(state));

  const restore = breakDisk('ENOSPC');
  try {
    // A normal write. The scheduled save behind it is now going to fail.
    assert.doesNotThrow(() => {
      api.addCourse({ name: 'COSC 1437', credit_hours: 4, term: 'Fall 2026' });
    }, 'a write whose save will fail must not throw at the call site');

    await settle(PERSIST_DELAY_MS + 250);

    const failed = api.saveState();
    assert.equal(failed.ok, false, 'save state reports the failure');
    assert.equal(failed.kind, 'disk_full', 'ENOSPC is classified as a full disk');
    assert.match(failed.message, /disk is full/i, 'the message names the real cause');
    assert.ok(failed.failedSince, 'the failure is timestamped');
    assert.ok(seen.some((s) => s.ok === false), 'the listener was told');
  } finally {
    restore();
  }

  // The data was never lost, only unsaved.
  assert.equal(api.listCourses().length, 1, 'the in-memory database kept the row');

  // Once the disk frees up, a scheduled retry must land on its own.
  await settle(2000);
  const recovered = api.saveState();
  assert.equal(recovered.ok, true, 'saving recovers without user action');
  assert.ok(seen.some((s) => s.ok === true), 'the listener was told about recovery');

  // And the row really did reach disk this time.
  const onDisk = fs.statSync(path.join(dir, 'nus.db')).size;
  assert.ok(onDisk > 0, 'the database file exists and is non-empty');

  setSaveStateListener(null);
});

test('a locked file is classified separately from a full disk', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-savelock-'));
  await open(dir);

  const restore = breakDisk('EBUSY');
  try {
    assert.doesNotThrow(() => api.addCourse({ name: 'MATH 2418', credit_hours: 4 }));
    await settle(PERSIST_DELAY_MS + 250);
    const state = api.saveState();
    assert.equal(state.ok, false);
    assert.equal(state.kind, 'locked', 'EBUSY reads as a lock, not a full disk');
    assert.match(state.message, /antivirus|holding/i);
  } finally {
    restore();
  }
  await settle(2000);
  assert.equal(api.saveState().ok, true, 'a transient lock clears on retry');
  setSaveStateListener(null);
});

test('flushPersist reports failure instead of throwing on quit', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nus-saveflush-'));
  await open(dir);
  api.addCourse({ name: 'PHYS 2325', credit_hours: 3 });

  const restore = breakDisk('EACCES');
  let result;
  try {
    // main.js calls this while quitting. Throwing there loses the session.
    assert.doesNotThrow(() => { result = api.flushPersist(); });
    assert.equal(result.ok, false, 'the caller learns the save did not land');
    assert.equal(result.kind, 'locked');
  } finally {
    restore();
  }

  await settle(350);
  assert.equal(api.saveState().ok, true,
    'canceling quit leaves an automatic recovery retry armed');
  setSaveStateListener(null);
});
