function decomposeTask(task) {
  const title = String(task.title || '').trim();
  const lower = title.toLowerCase();
  const total = Math.max(20, Number(task.estimated_minutes) || 60);
  let steps;

  if (/exam|midterm|final|study|quiz/.test(lower)) {
    steps = [
      'Collect the exact topics and materials',
      'Run a quick diagnostic without notes',
      'Review the weakest two topics',
      'Complete a timed practice pass',
      'Write the one-page final review sheet',
    ];
  } else if (/essay|paper|report|presentation|project/.test(lower)) {
    steps = [
      'Define the finished deliverable and rubric',
      'Gather the minimum sources and examples',
      'Build the outline or working skeleton',
      'Complete the rough first pass',
      'Revise, verify, and submit',
    ];
  } else if (/problem|homework|assignment|lab|chapter/.test(lower)) {
    steps = [
      'Scan every requirement and mark blockers',
      'Complete the easiest first pass',
      'Work the hard or uncertain section',
      'Check answers against the requirements',
      'Package and submit the final work',
    ];
  } else {
    steps = [
      'Define what done looks like',
      'Prepare the files, links, or materials',
      'Complete the smallest useful first pass',
      'Resolve the main blocker',
      'Review and close the task',
    ];
  }

  const each = Math.max(5, Math.round(total / steps.length / 5) * 5);
  return steps.map((step, index) => ({ title: step, order_index: index, estimated_minutes: each }));
}

function nextScheduledAt(triggerType, from = new Date()) {
  const next = new Date(from);
  if (triggerType === 'daily') next.setDate(next.getDate() + 1);
  else if (triggerType === 'weekly') next.setDate(next.getDate() + 7);
  else return null;
  return next.toISOString();
}

function parseIcs(text) {
  const unfolded = String(text || '').replace(/\r?\n[ \t]/g, '');
  const blocks = unfolded.split('BEGIN:VEVENT').slice(1).map((part) => part.split('END:VEVENT')[0]);
  return blocks.map((block) => {
    const fields = {};
    for (const line of block.split(/\r?\n/)) {
      const index = line.indexOf(':');
      if (index < 0) continue;
      const rawKey = line.slice(0, index).split(';')[0];
      fields[rawKey] = line.slice(index + 1).replace(/\\n/g, ' ').replace(/\\,/g, ',');
    }
    const rawDate = fields.DTSTART || fields.DTEND || '';
    const date = rawDate.match(/^(\d{4})(\d{2})(\d{2})/);
    return {
      title: fields.SUMMARY || 'Calendar event',
      due_date: date ? `${date[1]}-${date[2]}-${date[3]}` : null,
      notes: fields.DESCRIPTION || fields.LOCATION || '',
    };
  }).filter((event) => event.title);
}

module.exports = { decomposeTask, nextScheduledAt, parseIcs };
