const initSqlJs = require('sql.js');
const path = require('path');
const fs = require('fs');

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
  raw_text TEXT
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
`;

let db;
let dbFile;

async function open(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  dbFile = path.join(dataDir, 'nus.db');
  const SQL = await initSqlJs({ locateFile: (f) => path.join(path.dirname(require.resolve('sql.js')), f) });
  db = new SQL.Database(fs.existsSync(dbFile) ? fs.readFileSync(dbFile) : undefined);
  db.run('PRAGMA foreign_keys = ON');
  db.run(SCHEMA);
  migrateLegacyTables();
  seedIntegrations();
  persist();
  return db;
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

function persist() { fs.writeFileSync(dbFile, Buffer.from(db.export())); }

// Transcript lines arrive every few seconds during a capture session, and
// persist() rewrites the whole database file. Batch those writes: the row is
// in the in-memory db immediately, the file catches up within 2 seconds.
let persistTimer = null;
function persistSoon() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persist(); }, 2000);
}
function flushPersist() {
  if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
  persist();
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
  persist();
  return { changes: db.getRowsModified() };
}

function insert(sql, params = []) {
  db.run(sql, params);
  const id = all('SELECT last_insert_rowid() AS id')[0].id;
  persist();
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

  addSource: (s) => insert('INSERT INTO sources (course_id, file_path, title, source_type, raw_text) VALUES (?, ?, ?, ?, ?)',
    [s.course_id ?? null, s.file_path, s.title ?? path.basename(s.file_path), s.source_type ?? 'file', s.raw_text ?? null]),
  addActivity: (a) => insert('INSERT INTO activity (action_type, summary, detail, status, ref_table, ref_id) VALUES (?, ?, ?, ?, ?, ?)',
    [a.action_type, a.summary, a.detail ?? null, a.status ?? 'done', a.ref_table ?? null, a.ref_id ?? null]),
  updateActivity: (id, f) => dynamicUpdate('activity', id, f),
  listActivity: (limit = 20) => all('SELECT * FROM activity ORDER BY id DESC LIMIT ?', [limit]),

  updateSource: (id, f) => dynamicUpdate('sources', id, f),
  listSources: () => all(`SELECT s.*, c.name AS course_name FROM sources s LEFT JOIN courses c ON c.id = s.course_id ORDER BY s.imported_at DESC`),

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

module.exports = { open, api, normalizeRecurrenceKey };
