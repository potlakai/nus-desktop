const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const STORAGE_CAP_BYTES = 512 * 1024 * 1024;
const MAX_STORAGE_CAP_BYTES = 2 * 1024 * 1024 * 1024;
const PERSIST_DELAY_MS = 100;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS courses (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT,
  credit_hours REAL DEFAULT 3,
  term TEXT,
  source_file TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS grade_weights (
  id INTEGER PRIMARY KEY,
  course_id INTEGER REFERENCES courses(id),
  category TEXT NOT NULL,
  weight_pct REAL NOT NULL,
  expected_score_pct REAL DEFAULT 90
);
CREATE TABLE IF NOT EXISTS assignments (
  id INTEGER PRIMARY KEY,
  course_id INTEGER REFERENCES courses(id),
  grade_weight_id INTEGER REFERENCES grade_weights(id),
  title TEXT NOT NULL,
  due_date TEXT,
  status TEXT DEFAULT 'pending',
  score_pct REAL,
  source_confidence TEXT DEFAULT 'extracted',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  assignment_id INTEGER REFERENCES assignments(id),
  course_id INTEGER REFERENCES courses(id),
  title TEXT NOT NULL,
  due_date TEXT,
  done INTEGER DEFAULT 0,
  notes TEXT,
  source TEXT DEFAULT 'manual',
  recurrence_key TEXT,
  estimated_minutes INTEGER DEFAULT 30,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS task_steps (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  order_index INTEGER DEFAULT 0,
  done INTEGER DEFAULT 0,
  estimated_minutes INTEGER DEFAULT 15
);
CREATE TABLE IF NOT EXISTS reminders (
  id INTEGER PRIMARY KEY,
  task_id INTEGER REFERENCES tasks(id),
  fire_at TEXT NOT NULL,
  fired INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY,
  course_id INTEGER REFERENCES courses(id),
  file_path TEXT NOT NULL,
  title TEXT,
  source_type TEXT DEFAULT 'file',
  imported_at TEXT DEFAULT (datetime('now')),
  raw_text TEXT,
  content_path TEXT,
  content_bytes INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS integrations (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  status TEXT DEFAULT 'available',
  detail TEXT,
  config_json TEXT DEFAULT '{}',
  last_sync_at TEXT
);
CREATE TABLE IF NOT EXISTS automations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_json TEXT DEFAULT '{}',
  action_type TEXT NOT NULL,
  action_json TEXT DEFAULT '{}',
  enabled INTEGER DEFAULT 1,
  run_count INTEGER DEFAULT 0,
  last_run_at TEXT,
  next_run_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS companion_sessions (
  id INTEGER PRIMARY KEY,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  pack TEXT DEFAULT '',
  title TEXT DEFAULT '',
  audio_path TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS companion_messages (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES companion_sessions(id),
  ts TEXT NOT NULL,
  channel TEXT NOT NULL,
  text TEXT NOT NULL,
  mode TEXT,
  used_screenshot INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_companion_messages_session ON companion_messages(session_id);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY,
  action_type TEXT NOT NULL,
  summary TEXT NOT NULL,
  detail TEXT,
  status TEXT DEFAULT 'done',
  ref_table TEXT,
  ref_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value_text TEXT NOT NULL
);
`;

let db;
let dbFile;
let backupFile;
let sourceContentDir;
let persistTimer = null;
let SQLModule;

async function open(dataDir) {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  fs.mkdirSync(dataDir, { recursive: true });
  dbFile = path.join(dataDir, 'nus.db');
  backupFile = `${dbFile}.bak`;
  sourceContentDir = path.join(dataDir, 'source-content');
  fs.mkdirSync(sourceContentDir, { recursive: true });
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  SQLModule = SQL;
  db = loadDatabaseWithRecovery(SQL);
  db.run('PRAGMA foreign_keys = ON');
  db.run(SCHEMA);
  migrateLegacyTables();
  const migratedSources = migrateSourceContent();
  if (migratedSources) db.run('VACUUM');
  seedIntegrations();
  persist();
  // Replace the rolling backup with the sanitized database too, so migrated
  // raw source text does not survive inside nus.db.bak.
  if (migratedSources) persist();
  return db;
}

function verifiedDatabase(SQL, bytes) {
  const candidate = new SQL.Database(bytes);
  const result = candidate.exec('PRAGMA quick_check');
  const value = result?.[0]?.values?.[0]?.[0];
  if (value !== 'ok') {
    candidate.close();
    throw new Error(`SQLite integrity check failed: ${value || 'no result'}`);
  }
  return candidate;
}

function databaseGeneration(candidate) {
  try {
    const result = candidate.exec("SELECT value_text FROM app_meta WHERE key = 'save_generation'");
    return Number(result?.[0]?.values?.[0]?.[0]) || 0;
  } catch { return 0; }
}

function loadDatabaseWithRecovery(SQL) {
  const candidatePaths = [dbFile, `${dbFile}.new`, backupFile];
  const valid = [];
  const failures = [];
  for (const candidatePath of candidatePaths) {
    if (!fs.existsSync(candidatePath)) continue;
    try {
      const candidate = verifiedDatabase(SQL, fs.readFileSync(candidatePath));
      valid.push({ path: candidatePath, db: candidate, generation: databaseGeneration(candidate) });
    } catch (error) {
      failures.push(error);
    }
  }
  if (!valid.length) {
    if (!candidatePaths.some((candidatePath) => fs.existsSync(candidatePath))) return verifiedDatabase(SQL);
    throw new AggregateError(failures, 'The Nūs database, recovery candidate, and backup are unreadable.');
  }
  const priority = (candidatePath) => candidatePath === dbFile ? 2 : candidatePath.endsWith('.new') ? 1 : 0;
  valid.sort((a, b) => b.generation - a.generation || priority(b.path) - priority(a.path));
  const selected = valid[0];
  for (const item of valid.slice(1)) item.db.close();
  if (selected.path !== dbFile) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (fs.existsSync(dbFile)) fs.renameSync(dbFile, `${dbFile}.replaced-${stamp}`);
    console.error(`[nus] recovered database generation ${selected.generation} from ${selected.path}`);
  }
  return selected.db;
}

function tableColumns(table) {
  return all(`PRAGMA table_info(${table})`).map((row) => row.name);
}

function ensureColumn(table, column, definition) {
  if (!tableColumns(table).includes(column)) db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function migrateLegacyTables() {
  ensureColumn('tasks', 'course_id', 'INTEGER REFERENCES courses(id)');
  ensureColumn('tasks', 'notes', 'TEXT');
  ensureColumn('tasks', 'source', "TEXT DEFAULT 'manual'");
  ensureColumn('tasks', 'recurrence_key', 'TEXT');
  ensureColumn('tasks', 'estimated_minutes', 'INTEGER DEFAULT 30');
  ensureColumn('sources', 'title', 'TEXT');
  ensureColumn('sources', 'source_type', "TEXT DEFAULT 'file'");
  ensureColumn('sources', 'content_path', 'TEXT');
  ensureColumn('sources', 'content_bytes', 'INTEGER DEFAULT 0');
}

function migrateSourceContent() {
  const rows = all("SELECT id, raw_text FROM sources WHERE raw_text IS NOT NULL AND raw_text != ''");
  for (const row of rows) {
    const content = Buffer.from(String(row.raw_text), 'utf8');
    const contentPath = path.join(sourceContentDir, `legacy-source-${row.id}.txt`);
    atomicReplace(contentPath, content, false);
    db.run('UPDATE sources SET raw_text = NULL, content_path = ?, content_bytes = ? WHERE id = ?', [contentPath, content.length, row.id]);
  }
  db.run("UPDATE sources SET raw_text = NULL, content_bytes = 0 WHERE raw_text = ''");
  return rows.length;
}

function seedIntegrations() {
  const defaults = [
    ['syllabus', 'Syllabus (PDF or text)', 'ready', 'The heart of Nūs. Drop in a course syllabus and review what it read before anything is saved.'],
    ['calendar_file', 'Calendar file (.ics)', 'ready', 'Import any exported .ics calendar file.'],
    ['folder_import', 'Folder import', 'ready', 'Point Nūs at a folder and it reports what it imported, queued, and skipped.'],
    ['google_calendar', 'Google Calendar', 'needs_credentials', 'OAuth client ID required before live sync can be enabled.'],
    ['canvas', 'Canvas', 'needs_credentials', 'Requires your school Canvas domain and an approved OAuth client.'],
    ['blackboard', 'Blackboard', 'needs_admin', 'Requires an Anthology app registration and campus approval.'],
    ['chatgpt_export', 'ChatGPT history', 'ready', 'Import an exported JSON or HTML archive locally.'],
    ['claude_export', 'Claude history', 'ready', 'Import exported JSON, HTML, Markdown, or text locally.'],
    ['google_docs', 'Google Docs', 'ready', 'Import downloaded Docs as PDF, DOCX, Markdown, or text.'],
    ['icloud_notes', 'iCloud Notes', 'ready', 'Import exported notes as HTML, Markdown, or text.'],
  ];
  for (const row of defaults) {
    db.run('INSERT OR IGNORE INTO integrations (provider, label, status, detail) VALUES (?, ?, ?, ?)', row);
  }
  // Refresh copy on rows whose seeded text changed (INSERT OR IGNORE keeps stale rows alive).
  db.run("UPDATE integrations SET label = 'Calendar file (.ics)', detail = 'Import any exported .ics calendar file.' WHERE provider = 'calendar_file' AND status != 'connected'");
}

function renameReplace(source, target) {
  let lastError;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try { fs.renameSync(source, target); return; }
    catch (error) {
      lastError = error;
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (attempt + 1));
    }
  }
  throw lastError;
}

function atomicReplace(target, bytes, keepBackup = false) {
  const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temp, 'w', 0o600);
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    if (keepBackup && fs.existsSync(target)) atomicReplace(`${target}.bak`, fs.readFileSync(target), false);
    renameReplace(temp, target);
  } finally {
    if (fd !== null && fd !== undefined) { try { fs.closeSync(fd); } catch {} }
    if (fs.existsSync(temp)) { try { fs.unlinkSync(temp); } catch {} }
  }
}

function persist() {
  const current = Number(all("SELECT value_text FROM app_meta WHERE key = 'save_generation'")[0]?.value_text) || 0;
  db.run("INSERT INTO app_meta (key, value_text) VALUES ('save_generation', ?) ON CONFLICT(key) DO UPDATE SET value_text = excluded.value_text", [String(current + 1)]);
  const candidateFile = `${dbFile}.new`;
  atomicReplace(candidateFile, Buffer.from(db.export()), false);
  const candidate = verifiedDatabase(SQLModule, fs.readFileSync(candidateFile));
  const candidateGeneration = databaseGeneration(candidate);
  candidate.close();
  if (candidateGeneration !== current + 1) throw new Error('Database save generation did not survive export.');
  if (fs.existsSync(dbFile)) {
    const installed = verifiedDatabase(SQLModule, fs.readFileSync(dbFile));
    installed.close();
    atomicReplace(backupFile, fs.readFileSync(dbFile), false);
  }
  renameReplace(candidateFile, dbFile);
  const installed = verifiedDatabase(SQLModule, fs.readFileSync(dbFile));
  installed.close();
}

// Transcript lines arrive every few seconds during a capture session, and
// persist() rewrites the whole database file. Batch those writes: the row is
// in the in-memory db immediately, the file catches up within 100 ms.
// persist() can fail for three quite different reasons, and none of them mean
// the user's data is gone: the in-memory database is still the correct, complete
// copy. Crashing is therefore the one response that guarantees losing it, which
// is what an unguarded throw inside this timer used to do.
//
//   ENOSPC                  the disk is full. The user can fix that. Keep running.
//   EBUSY/EPERM/EACCES/EROFS the file is locked, usually antivirus touching it
//                           mid-rename on Windows. Almost always transient.
//   anything else           an exported copy did not survive verification.
//
// So: never throw out of the scheduled save, retry with a backoff, and surface
// it so nobody works for an hour believing they are saved. A retry can only
// help, because every attempt re-exports the current database rather than
// replaying a stale buffer.
const SAVE_RETRY_DELAYS_MS = [200, 1000, 5000, 15000];
let saveRetryIndex = 0;
let saveState = { ok: true, kind: null, message: null, failedSince: null };
let saveStateListener = null;
let activeStorageCapBytes = STORAGE_CAP_BYTES;

function classifySaveError(error) {
  const code = error && error.code;
  if (code === 'ENOSPC') {
    return { kind: 'disk_full', message: 'Your disk is full, so Nūs cannot save. Free up space and it will retry on its own.' };
  }
  if (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES' || code === 'EROFS') {
    return { kind: 'locked', message: 'Another program on this PC is holding the Nūs database file, often antivirus. Retrying.' };
  }
  return { kind: 'integrity', message: 'Nūs could not verify a saved copy of your data. Everything is still here and open, but it is not reaching the disk.' };
}

function setSaveStateListener(fn) { saveStateListener = typeof fn === 'function' ? fn : null; }
function getSaveState() { return { ...saveState }; }

function emitSaveState(next) {
  const changed = next.ok !== saveState.ok || next.kind !== saveState.kind;
  saveState = next;
  if (changed && saveStateListener) { try { saveStateListener(getSaveState()); } catch {} }
}

function noteSaveSucceeded() {
  saveRetryIndex = 0;
  if (!saveState.ok) console.error('[nus] saving recovered');
  emitSaveState({ ok: true, kind: null, message: null, failedSince: null });
}

function noteSaveFailed(error) {
  const info = classifySaveError(error);
  console.error('[nus] save failed:', info.kind, (error && error.message) || error);
  emitSaveState({
    ok: false,
    kind: info.kind,
    message: info.message,
    failedSince: saveState.failedSince || new Date().toISOString(),
  });
  const delay = SAVE_RETRY_DELAYS_MS[Math.min(saveRetryIndex, SAVE_RETRY_DELAYS_MS.length - 1)];
  saveRetryIndex += 1;
  return delay;
}

function runScheduledPersist() {
  persistTimer = null;
  try {
    persist();
    noteSaveSucceeded();
  } catch (error) {
    const delay = noteSaveFailed(error);
    persistTimer = setTimeout(runScheduledPersist, delay);
    persistTimer.unref?.();
  }
}

function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(runScheduledPersist, PERSIST_DELAY_MS);
  persistTimer.unref?.();
}

// Called on quit and at the end of a Companion session, where throwing is worse
// than reporting. Returns the outcome so a caller that can act on it does.
function flushPersist() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  try {
    persist();
    noteSaveSucceeded();
    return { ok: true };
  } catch (error) {
    const delay = noteSaveFailed(error);
    // A canceled quit leaves the app running. Keep the same unattended recovery
    // guarantee as a normal scheduled save, even though this flush cleared the
    // previous timer before trying.
    persistTimer = setTimeout(runScheduledPersist, delay);
    persistTimer.unref?.();
    return { ok: false, kind: saveState.kind, message: saveState.message };
  }
}
function insertLazy(sql, params = []) {
  db.run(sql, params);
  const id = all('SELECT last_insert_rowid() AS id')[0].id;
  persistSoon();
  return id; // same shape as insert(), so callers can't get this wrong
}

function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function run(sql, params = []) {
  db.run(sql, params);
  persistSoon();
  return { changes: db.getRowsModified() };
}

function insert(sql, params = []) {
  db.run(sql, params);
  const id = all('SELECT last_insert_rowid() AS id')[0].id;
  persistSoon();
  return id;
}

function normalizeRecurrenceKey(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/\b(?:week|chapter|module|quiz|homework|assignment|set)\s*\d+\b/g, '')
    .replace(/\b\d+\b/g, '')
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .slice(0, 80);
}

const api = {
  addCourse: (c) => insert('INSERT INTO courses (name, code, credit_hours, term, source_file) VALUES (?, ?, ?, ?, ?)',
    [c.name, c.code ?? null, c.credit_hours ?? 3, c.term ?? null, c.source_file ?? null]),
  updateCourse: (id, f) => dynamicUpdate('courses', id, f),
  deleteCourse: (id) => run('DELETE FROM courses WHERE id = ?', [id]),
  listCourses: () => all('SELECT * FROM courses ORDER BY name'),

  addGradeWeight: (w) => insert('INSERT INTO grade_weights (course_id, category, weight_pct, expected_score_pct) VALUES (?, ?, ?, ?)',
    [w.course_id, w.category, w.weight_pct, w.expected_score_pct ?? 90]),
  updateGradeWeight: (id, f) => dynamicUpdate('grade_weights', id, f),
  listGradeWeights: (courseId) => all('SELECT * FROM grade_weights WHERE course_id = ?', [courseId]),

  addAssignment: (a) => insert(`INSERT INTO assignments (course_id, grade_weight_id, title, due_date, status, score_pct, source_confidence)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [a.course_id, a.grade_weight_id ?? null, a.title, a.due_date ?? null,
      a.status ?? 'pending', a.score_pct ?? null, a.source_confidence ?? 'extracted']),
  updateAssignment: (id, f) => dynamicUpdate('assignments', id, f),
  deleteAssignment: (id) => run('DELETE FROM assignments WHERE id = ?', [id]),
  listAssignments: (courseId) => courseId
    ? all('SELECT * FROM assignments WHERE course_id = ? ORDER BY due_date', [courseId])
    : all('SELECT * FROM assignments ORDER BY due_date'),

  addTask: (t) => insert(`INSERT INTO tasks (assignment_id, course_id, title, due_date, notes, source, recurrence_key, estimated_minutes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [t.assignment_id ?? null, t.course_id ?? null, t.title, t.due_date ?? null,
      t.notes ?? null, t.source ?? 'manual', t.recurrence_key || normalizeRecurrenceKey(t.title), t.estimated_minutes ?? 30]),
  updateTask: (id, f) => dynamicUpdate('tasks', id, f),
  deleteTask: (id) => run('DELETE FROM tasks WHERE id = ?', [id]),
  listTasks: () => all(`SELECT t.*, COALESCE(c.name, ac.name, 'General') AS course_name
    FROM tasks t LEFT JOIN courses c ON c.id = t.course_id
    LEFT JOIN assignments a ON a.id = t.assignment_id LEFT JOIN courses ac ON ac.id = a.course_id
    ORDER BY t.done, CASE WHEN t.due_date IS NULL THEN 1 ELSE 0 END, t.due_date, t.id DESC`),
  addTaskStep: (s) => insert('INSERT INTO task_steps (task_id, title, order_index, done, estimated_minutes) VALUES (?, ?, ?, ?, ?)',
    [s.task_id, s.title, s.order_index ?? 0, s.done ? 1 : 0, s.estimated_minutes ?? 15]),
  listTaskSteps: (taskId) => all('SELECT * FROM task_steps WHERE task_id = ? ORDER BY order_index, id', [taskId]),
  updateTaskStep: (id, f) => dynamicUpdate('task_steps', id, f),
  repeatedTaskSignals: () => all(`SELECT recurrence_key, COUNT(*) AS occurrences, MAX(title) AS example_title
    FROM tasks WHERE recurrence_key IS NOT NULL AND recurrence_key != '' GROUP BY recurrence_key HAVING COUNT(*) >= 2 ORDER BY occurrences DESC`),

  addReminder: (r) => insert('INSERT INTO reminders (task_id, fire_at) VALUES (?, ?)', [r.task_id, r.fire_at]),
  dueReminders: (nowIso) => all(`SELECT r.*, t.title AS task_title FROM reminders r JOIN tasks t ON t.id = r.task_id
    WHERE r.fired = 0 AND r.fire_at <= ?`, [nowIso]),
  markFired: (id) => run('UPDATE reminders SET fired = 1 WHERE id = ?', [id]),

  addSource: (s) => addSource(s),
  addActivity: (a) => insert('INSERT INTO activity (action_type, summary, detail, status, ref_table, ref_id) VALUES (?, ?, ?, ?, ?, ?)',
    [a.action_type, a.summary, a.detail ?? null, a.status ?? 'done', a.ref_table ?? null, a.ref_id ?? null]),
  updateActivity: (id, f) => dynamicUpdate('activity', id, f),
  listActivity: (limit = 20) => all('SELECT * FROM activity ORDER BY id DESC LIMIT ?', [limit]),

  updateSource: (id, f) => dynamicUpdate('sources', id, f),
  listSources: () => all(`SELECT s.id, s.course_id, s.file_path, s.title, s.source_type, s.imported_at, s.content_bytes,
    c.name AS course_name FROM sources s LEFT JOIN courses c ON c.id = s.course_id ORDER BY s.imported_at DESC`),
  getSourceText: (id) => getSourceText(id),
  storageStatus: () => storageStatus(),
  setStorageCapBytes: (bytes) => setStorageCapBytes(bytes),
  saveState: () => getSaveState(),

  listIntegrations: () => all('SELECT * FROM integrations ORDER BY CASE status WHEN \'connected\' THEN 0 WHEN \'ready\' THEN 1 ELSE 2 END, label'),
  updateIntegration: (provider, fields) => dynamicUpdateBy('integrations', 'provider', provider, fields),

  addAutomation: (a) => insert(`INSERT INTO automations (name, trigger_type, trigger_json, action_type, action_json, enabled, next_run_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`, [a.name, a.trigger_type, JSON.stringify(a.trigger || {}), a.action_type,
      JSON.stringify(a.action || {}), a.enabled === false ? 0 : 1, a.next_run_at ?? null]),
  listAutomations: () => all('SELECT * FROM automations ORDER BY enabled DESC, id DESC'),
  updateAutomation: (id, f) => dynamicUpdate('automations', id, f),
  dueAutomations: (nowIso) => all('SELECT * FROM automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?', [nowIso]),
  markAutomationRun: (id, lastRunAt, nextRunAt) => run('UPDATE automations SET run_count = run_count + 1, last_run_at = ?, next_run_at = ? WHERE id = ?', [lastRunAt, nextRunAt, id]),

  addCompanionSession: (session) => insert('INSERT INTO companion_sessions (started_at, pack) VALUES (?, ?)',
    [session.started_at, session.pack ?? '']),
  updateCompanionSession: (id, f) => dynamicUpdate('companion_sessions', id, f),
  listCompanionSessions: (limit = 200) => all(`SELECT s.*,
      (SELECT COUNT(*) FROM companion_messages m WHERE m.session_id = s.id) AS message_count,
      (SELECT text FROM companion_messages m WHERE m.session_id = s.id ORDER BY m.id LIMIT 1) AS first_line
    FROM companion_sessions s ORDER BY s.id DESC LIMIT ?`, [limit]),
  listCompanionMessages: (sessionId) => all('SELECT * FROM companion_messages WHERE session_id = ? ORDER BY id', [sessionId]),
  searchCompanionMessages: (q, limit = 80) => all(`SELECT m.*, s.started_at AS session_started_at, s.pack AS session_pack
    FROM companion_messages m JOIN companion_sessions s ON s.id = m.session_id
    WHERE m.text LIKE ? ORDER BY m.id DESC LIMIT ?`, ['%' + q + '%', limit]),
  addCompanionMessage: (sessionId, turn) => insertLazy(
    'INSERT INTO companion_messages (session_id, ts, channel, text, mode, used_screenshot) VALUES (?, ?, ?, ?, ?, ?)',
    [sessionId, new Date(turn.ts || Date.now()).toISOString(), turn.channel, turn.text, turn.mode ?? null, turn.used_screenshot ? 1 : 0]),
  flushPersist: () => flushPersist(),

  setPreference: (key, value) => run('INSERT INTO preferences (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json', [key, JSON.stringify(value)]),
  getPreferences: () => Object.fromEntries(all('SELECT * FROM preferences').map((row) => {
    try { return [row.key, JSON.parse(row.value_json)]; } catch { return [row.key, row.value_json]; }
  })),
};

function sourceStorageBytes() {
  if (!sourceContentDir || !fs.existsSync(sourceContentDir)) return 0;
  return fs.readdirSync(sourceContentDir, { withFileTypes: true }).reduce((sum, entry) => {
    if (!entry.isFile()) return sum;
    try { return sum + fs.statSync(path.join(sourceContentDir, entry.name)).size; } catch { return sum; }
  }, 0);
}

function storageStatus() {
  let dbBytes = 0;
  try { dbBytes = fs.statSync(dbFile).size; } catch {}
  const sourceBytes = sourceStorageBytes();
  return { dbBytes, sourceBytes, usedBytes: dbBytes + sourceBytes, capBytes: activeStorageCapBytes };
}

function setStorageCapBytes(bytes) {
  const requested = Number(bytes);
  activeStorageCapBytes = Number.isFinite(requested)
    ? Math.max(STORAGE_CAP_BYTES, Math.min(MAX_STORAGE_CAP_BYTES, Math.floor(requested)))
    : STORAGE_CAP_BYTES;
  return activeStorageCapBytes;
}

function addSource(s) {
  const rawText = s.raw_text === null || s.raw_text === undefined ? null : String(s.raw_text);
  let contentPath = null;
  let contentBytes = 0;
  if (rawText !== null) {
    const content = Buffer.from(rawText, 'utf8');
    const status = storageStatus();
    if (status.usedBytes + content.length > activeStorageCapBytes) {
      const error = new Error('Nūs local storage is full. Remove an import before adding another.');
      error.code = 'STORAGE_LIMIT';
      throw error;
    }
    contentPath = path.join(sourceContentDir, `source-${crypto.randomUUID()}.txt`);
    atomicReplace(contentPath, content, false);
    contentBytes = content.length;
  }
  try {
    return insert('INSERT INTO sources (course_id, file_path, title, source_type, raw_text, content_path, content_bytes) VALUES (?, ?, ?, ?, NULL, ?, ?)',
      [s.course_id ?? null, s.file_path, s.title ?? path.basename(s.file_path), s.source_type ?? 'file', contentPath, contentBytes]);
  } catch (error) {
    if (contentPath && fs.existsSync(contentPath)) { try { fs.unlinkSync(contentPath); } catch {} }
    throw error;
  }
}

function getSourceText(id) {
  const source = all('SELECT raw_text, content_path FROM sources WHERE id = ?', [id])[0];
  if (!source) return null;
  if (source.content_path) {
    const resolved = path.resolve(source.content_path);
    const root = path.resolve(sourceContentDir) + path.sep;
    if (!resolved.startsWith(root)) return null;
    try { return fs.readFileSync(resolved, 'utf8'); } catch { return null; }
  }
  return source.raw_text === null || source.raw_text === undefined ? null : String(source.raw_text);
}

const ALLOWED_FIELDS = {
  courses: ['name', 'code', 'credit_hours', 'term', 'source_file'],
  grade_weights: ['category', 'weight_pct', 'expected_score_pct'],
  assignments: ['grade_weight_id', 'title', 'due_date', 'status', 'score_pct', 'source_confidence'],
  tasks: ['title', 'due_date', 'done', 'notes', 'course_id', 'estimated_minutes', 'recurrence_key'],
  task_steps: ['title', 'done', 'estimated_minutes', 'order_index'],
  integrations: ['label', 'status', 'detail', 'config_json', 'last_sync_at'],
  automations: ['name', 'enabled', 'next_run_at', 'trigger_json', 'action_json'],
  sources: ['course_id', 'title', 'source_type'],
  activity: ['status', 'summary', 'detail'],
  companion_sessions: ['ended_at', 'audio_path', 'title', 'pack'],
};

function dynamicUpdate(table, id, fields) { return dynamicUpdateBy(table, 'id', id, fields); }
function dynamicUpdateBy(table, keyName, keyValue, fields) {
  const keys = Object.keys(fields || {}).filter((key) => ALLOWED_FIELDS[table]?.includes(key));
  if (!keys.length) return { changes: 0 };
  const setClause = keys.map((key) => `${key} = ?`).join(', ');
  return run(`UPDATE ${table} SET ${setClause} WHERE ${keyName} = ?`, [...keys.map((key) => fields[key]), keyValue]);
}

module.exports = { open, api, normalizeRecurrenceKey, setSaveStateListener, STORAGE_CAP_BYTES, MAX_STORAGE_CAP_BYTES };
