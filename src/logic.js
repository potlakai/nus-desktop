// Deterministic ranking + GPA math from mvp-desktop-alpha.md §5-6.
// No model calls here, ever: due dates and grades are decided by code.

function daysLeft(dueDateIso, now = new Date()) {
  if (!dueDateIso) return null;
  const due = new Date(dueDateIso + 'T23:59:59');
  return Math.floor((due - now) / 86400000);
}

function urgency(d) {
  if (d === null) return 0.3;
  if (d < 0) return 3.0;
  if (d === 0) return 2.5;
  if (d <= 2) return 2.0;
  if (d <= 7) return 1.0;
  return 0.3;
}

function reasonString(d, weightPct, courseName, dueDate) {
  if (weightPct == null || weightPct === 0) return `You added this for ${dueDate || 'no date'}.`;
  const when = d === 0 ? 'today' : d < 0 ? `${-d} day${-d === 1 ? '' : 's'} ago` : `in ${d} day${d === 1 ? '' : 's'}`;
  return `Due ${when}, worth ${weightPct}% of your grade in ${courseName}.`;
}

// items: [{title, due_date, weight_pct, course_name}]
function rankToday(items, now = new Date(), limit = 5) {
  return items
    .map((it) => {
      const d = daysLeft(it.due_date, now);
      const w = it.weight_pct || 0;
      return {
        ...it,
        days_left: d,
        score: urgency(d) * (w > 0 ? w / 100 : 0.05),
        reason: reasonString(d, w, it.course_name, it.due_date),
      };
    })
    .sort((a, b) => b.score - a.score || String(a.due_date).localeCompare(String(b.due_date)))
    .slice(0, limit);
}

// Grading scales differ by school; the default is the common US plus/minus
// table, and Settings lets the student edit/verify their own (stored in
// preferences.gpa_scale as [{min, letter, points}]).
const GRADE_TABLE = [
  [93, 'A', 4.0], [90, 'A-', 3.7], [87, 'B+', 3.3], [83, 'B', 3.0],
  [80, 'B-', 2.7], [77, 'C+', 2.3], [73, 'C', 2.0], [70, 'C-', 1.7],
  [67, 'D+', 1.3], [63, 'D', 1.0], [60, 'D-', 0.7], [0, 'F', 0.0],
];

const SCALE_PRESETS = {
  'plus-minus': GRADE_TABLE.map(([min, letter, points]) => ({ min, letter, points })),
  'whole-letter': [[90, 'A', 4.0], [80, 'B', 3.0], [70, 'C', 2.0], [60, 'D', 1.0], [0, 'F', 0.0]].map(([min, letter, points]) => ({ min, letter, points })),
};

function normalizeScale(scale) {
  if (!Array.isArray(scale)) return null;
  const rows = scale
    .map((row) => ({ min: Number(row.min), letter: String(row.letter || '').trim().slice(0, 4), points: Number(row.points) }))
    .filter((row) => row.letter && Number.isFinite(row.min) && Number.isFinite(row.points) && row.min >= 0 && row.min <= 100 && row.points >= 0 && row.points <= 5);
  if (!rows.length) return null;
  rows.sort((a, b) => b.min - a.min);
  return rows;
}

function toLetter(pct, scale) {
  const rows = normalizeScale(scale) || SCALE_PRESETS['plus-minus'];
  for (const row of rows) if (pct >= row.min) return { letter: row.letter, points: row.points };
  const last = rows[rows.length - 1];
  return { letter: last.letter, points: last.points };
}

// weights: [{id, weight_pct, expected_score_pct}], assignments: [{grade_weight_id, status, score_pct}]
function projectCourse(weights, assignments, scale) {
  let known = 0, assumed = 0, knownWeight = 0, assumedWeight = 0;
  for (const w of weights) {
    const graded = assignments.filter((a) => a.grade_weight_id === w.id && a.status === 'graded' && a.score_pct != null);
    if (graded.length) {
      const avg = graded.reduce((s, a) => s + a.score_pct, 0) / graded.length;
      known += (w.weight_pct / 100) * avg;
      knownWeight += w.weight_pct;
    } else {
      assumed += (w.weight_pct / 100) * (w.expected_score_pct ?? 90);
      assumedWeight += w.weight_pct;
    }
  }
  const pct = known + assumed;
  return { projected_pct: pct, ...toLetter(pct, scale), known_weight: knownWeight, assumed_weight: assumedWeight };
}

// perCourse: [{credit_hours, points}]
function overallGpa(perCourse) {
  const hours = perCourse.reduce((s, c) => s + c.credit_hours, 0);
  if (!hours) return null;
  return perCourse.reduce((s, c) => s + c.points * c.credit_hours, 0) / hours;
}

module.exports = { daysLeft, urgency, rankToday, projectCourse, overallGpa, toLetter, SCALE_PRESETS, normalizeScale };
