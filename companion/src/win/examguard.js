// Proctored exams: the Companion does not run beside a lockdown browser. When
// one is open the app says so once and closes; it does not hide and wait.
const { execFile } = require('child_process');

// Respondus LockDown Browser, campus and OEM builds.
const EXAM_PROCESSES = /^lockdownbrowser(oem)?\.exe$/i;
const MESSAGE = {
  title: 'Nūs Companion is off',
  message: 'Nūs Companion does not run during proctored exams.',
  detail: 'LockDown Browser is open, so the Companion has closed. Open it again after your exam.',
};

// `tasklist /FO CSV /NH` rows: "Image Name","PID",...
function examProcess(csv) {
  for (const line of String(csv || '').split(/\r?\n/)) {
    const m = /^"([^"]+)"/.exec(line);
    if (m && EXAM_PROCESSES.test(m[1])) return m[1];
  }
  return null;
}

// Only LockDown Browser's own rows, filtered inside tasklist. The full list
// cost about 1.1 s of CPU per call on a PC with 420 processes (measured
// 2026-11-07), every 5 s, in a tasklist.exe that Task Manager does not show
// under Nūs. Filtered it is about 0.1 s. The wildcard keeps the OEM build.
const LIST_ARGS = ['/FI', 'IMAGENAME eq lockdownbrowser*', '/FO', 'CSV', '/NH'];
function listProcesses() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('');
    execFile('tasklist', LIST_ARGS, { windowsHide: true, timeout: 5000 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// check() resolves to the process name or null. watch() calls onExam once,
// the first time a check finds one, and then stops looking.
function createExamGuard({ list = listProcesses, intervalMs = 5000, onExam = () => {} } = {}) {
  let timer = null, fired = false;
  async function check() { try { return examProcess(await list()); } catch { return null; } }
  async function tick() {
    if (fired) return;
    const name = await check();
    if (!name || fired) return;
    fired = true;
    stop();
    onExam(name);
  }
  function watch() { if (!timer && !fired) { timer = setInterval(tick, intervalMs); if (timer.unref) timer.unref(); } }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  return { check, tick, watch, stop };
}

module.exports = { createExamGuard, examProcess, MESSAGE, LIST_ARGS };
