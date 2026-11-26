const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createExamGuard, examProcess, MESSAGE } = require('../src/win/examguard');

const row = (name, pid) => `"${name}","${pid}","Console","1","12,345 K"`;

test('finds LockDown Browser, campus and OEM, in a tasklist dump', () => {
  assert.equal(examProcess([row('firefox.exe', 1), row('LockDownBrowser.exe', 2)].join('\r\n')), 'LockDownBrowser.exe');
  assert.equal(examProcess(row('lockdownbrowseroem.exe', 3)), 'lockdownbrowseroem.exe');
  assert.equal(examProcess([row('firefox.exe', 1), row('electron.exe', 2)].join('\r\n')), null);
  assert.equal(examProcess(row('NotLockDownBrowser.exe', 4)), null);
  assert.equal(examProcess(''), null);
});

test('stands down once, the first time an exam browser appears', async () => {
  let dump = row('firefox.exe', 1);
  const seen = [];
  const guard = createExamGuard({ list: async () => dump, onExam: (name) => seen.push(name) });
  assert.equal(await guard.check(), null);
  await guard.tick();
  assert.deepEqual(seen, []);
  dump += '\r\n' + row('LockDownBrowser.exe', 9);
  await guard.tick();
  await guard.tick();
  assert.deepEqual(seen, ['LockDownBrowser.exe']);
});

test('a failed process list is not an exam', async () => {
  const guard = createExamGuard({ list: async () => { throw new Error('tasklist missing'); } });
  assert.equal(await guard.check(), null);
});

test('the message has no em dashes', () => {
  assert.ok(!/—/.test(Object.values(MESSAGE).join(' ')));
});

test('tasklist filters to LockDown Browser itself, never the full process list', () => {
  const { LIST_ARGS } = require('../src/win/examguard');
  assert.deepEqual(LIST_ARGS, ['/FI', 'IMAGENAME eq lockdownbrowser*', '/FO', 'CSV', '/NH']);
  assert.equal(examProcess('INFO: No tasks are running which match the specified criteria.'), null, 'no match reads as none');
  assert.equal(examProcess('"LockDownBrowserOEM.exe","4120","Console","3","120,000 K"'), 'LockDownBrowserOEM.exe');
});
