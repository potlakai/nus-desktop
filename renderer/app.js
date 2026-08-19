const isPreview = !window.nus;
const api = window.nus || createPreviewApi();
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const state = {
  data: { courses: [], assignments: [], tasks: [], sources: [], integrations: [], automations: [], repeated_signals: [], preferences: {}, ranked: [], gpa: { courses: [], overall: null } },
  view: 'today',
  calendarCursor: new Date(),
  selectedDay: new Date().toISOString().slice(0, 10),
  brain: { scale: 1, offsetX: 0, offsetY: 0, positions: {}, viewportLoaded: false },
  kb: { query: '', selected: null, collapsed: {} },
};

const copy = {
  today: ['Your semester, in focus.', 'Today'],
  calendar: ['Time, without the surprise.', 'Calendar'],
  tasks: ['Turn ambition into the next move.', 'Smart tasks'],
  brain: ['See the semester think.', 'Map'],
  automations: ['Let the pattern carry itself.', 'Automations'],
  integrations: ['Bring the outside world into focus.', 'Integrations'],
  semester: ['The full arc, before it surprises you.', 'Semester'],
  sources: ['Your context, with receipts.', 'Knowledge'],
  email: ['Email your professor, in your voice.', 'Email'],
  companion: ['Your on-screen agent, on call.', 'Companion'],
  history: ['Every session, remembered.', 'History'],
  settings: ['Private by design.', 'Settings'],
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
}
function isoDay(date = new Date()) { const copyDate = new Date(date); copyDate.setHours(12,0,0,0); return copyDate.toISOString().slice(0,10); }
function dayDistance(value) { if (!value) return null; return Math.floor((new Date(`${value}T23:59:59`) - new Date()) / 86400000); }
function relativeDue(value) { const days = dayDistance(value); if (days === null) return 'No date'; if (days < 0) return `${Math.abs(days)}d overdue`; if (days === 0) return 'Due today'; if (days === 1) return 'Due tomorrow'; return `Due in ${days} days`; }
function shortDate(value) { return value ? new Date(`${value}T12:00:00`).toLocaleDateString(undefined,{month:'short',day:'numeric'}) : 'Open'; }
function prettyDate(value) { return new Date(`${value}T12:00:00`).toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}); }
function showToast(message) { const toast = $('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove('show'), 3200); }

async function load() {
  state.data = await api.getState();
  state.authConfig = await api.authConfig().catch(() => ({}));
  api.companionStatus?.().then((s)=>{ if(s){ companionState=s; renderHero(); } }).catch(()=>{});
  renderAll();
  if (state.authConfig.outlook) {
    api.outlookStatus().then(async (status) => {
      state.outlook = status;
      if (status.connected) {
        state.style = await api.styleProfile().catch(() => null);
        state.inbox = await api.outlookInbox().catch(() => null);
      }
      renderHero(); renderInbox();
    }).catch(() => {});
  }
}

// The rail is the single source of truth for navigation. Each top-level entry
// is one view; `children` render inline beneath it and stay expanded whenever
// that section is active. Map is promoted out of Semester to its own top-level
// item because the knowledge graph is the product's whole thesis, not a pill
// two clicks deep. Adding a view is a one-line change here.
const rail = [
  { view: 'today', label: 'Today' },
  { view: 'brain', label: 'Map' },
  { view: 'calendar', label: 'Calendar' },
  { view: 'tasks', label: 'Smart tasks' },
  { view: 'semester', label: 'Semester', children: [['semester', 'Overview'], ['sources', 'Knowledge']] },
  { view: 'companion', label: 'Knot', children: [['companion', 'Companion'], ['history', 'History']] },
  { view: 'email', label: 'Email' },
  { view: 'automations', label: 'Connections', children: [['automations', 'Automations'], ['integrations', 'Integrations']] },
  { view: 'settings', label: 'Settings' },
];
// Derived: which top-level rail item lights up for any given view.
const viewParent = {};
for (const item of rail) for (const [key] of (item.children || [])) if (key !== item.view) viewParent[key] = item.view;

function renderNav() {
  const railView = viewParent[state.view] || state.view;
  $('#nav').innerHTML = rail.map((item, index) => {
    const num = String(index + 1).padStart(2, '0');
    const isActive = item.view === railView;
    const parent = `<button data-view="${item.view}" class="nav-item${isActive ? ' active' : ''}"><span class="nav-icon">${num}</span><span>${item.label}</span></button>`;
    if (!item.children || !isActive) return parent;
    const kids = item.children.map(([key, label]) =>
      `<button data-view="${key}" class="nav-sub${key === state.view ? ' active' : ''}">${label}</button>`).join('');
    return parent + `<div class="nav-children">${kids}</div>`;
  }).join('');
}

function setView(name) {
  api.setActiveView?.(name);
  state.view = name;
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === `view-${name}`));
  $('#eyebrow').textContent = `${new Date().toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'})} · ${copy[name][1]}`;
  $('#view-title').textContent = copy[name][0];
  renderNav();
  if (name === 'brain') setTimeout(renderBrain, 40);
  if (name === 'sources') renderSources();
  if (name === 'settings') renderSettings();
  if (name === 'email') renderEmail();
  if (name === 'companion') { renderCompanionPanel(); renderChat(); }
  if (name === 'history') renderHistory();
}
$('#nav').addEventListener('click', (event) => {
  const button = event.target.closest('[data-view]');
  if (button) setView(button.dataset.view);
});
$$('[data-altitude]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.altitude)));

// The rail-profile button and any other stray [data-view] outside the nav.
$$('.workspace [data-view], .rail-profile[data-view]').forEach((button) => button.addEventListener('click', () => setView(button.dataset.view)));

function renderAll() {
  renderToday();
  renderCalendar();
  renderMiniCalendar();
  renderTasks();
  renderTodo();
  renderConnections();
  renderStorage();
  renderSemester();
  renderSources();
  renderIntegrations();
  renderAutomations();
  renderAuthState();
  if (state.view === 'brain') renderBrain();
  if (state.view === 'email') renderEmail();
}

function renderToday() {
  const { ranked, gpa } = state.data;
  const next = ranked[0];
  const urgent = ranked.filter((item) => item.days_left !== null && item.days_left <= 2);
  const overdue = ranked.filter((item) => item.days_left < 0);
  $('#brief-copy').textContent = next
    ? `${urgent.length ? `${urgent.length} item${urgent.length === 1 ? '' : 's'} need attention.` : 'Your near-term load is calm.'} ${next.title} is the clearest next move.`
    : 'Your semester is quiet. Import one real syllabus or add one commitment and Nūs will shape the day around it.';
  $('#today-list').innerHTML = ranked.length ? ranked.slice(0,3).map((item) => `<div class="move-row"><button class="check-button" data-move="${item.id}" title="Mark done">✓</button><div><strong>${esc(item.title)}</strong><small>${esc(item.course_name || 'General')} · ${esc(relativeDue(item.due_date))}</small></div><span class="due-chip">${esc(shortDate(item.due_date))}</span></div>`).join('') : '<div class="empty-state"><strong>Nothing ranked yet.</strong>Import a syllabus or add a task and your next three moves appear here.</div>';
  renderHero();
  renderActivity();
  renderInbox();
  const overall = gpa.overall;
  $('#gpa-pulse').innerHTML = `<div class="section-kicker">Semester pulse</div><div class="metric-row"><div class="metric-big">${overall == null ? '—' : overall.toFixed(2)}</div><div class="metric-caption">${overall == null ? 'Add grading weights to project your GPA.' : 'Projected GPA from known and assumed work.'}</div></div><div class="projection-track"><i style="width:${overall == null ? 0 : Math.min(100,overall/4*100)}%"></i></div>`;
  $('#risk-pulse').innerHTML = `<div class="section-kicker">Risk watch</div>${overdue.length ? overdue.slice(0,2).map((item) => `<div class="risk-item"><i></i><div><strong>${esc(item.title)}</strong><small>${esc(item.course_name)}</small></div><span>${Math.abs(item.days_left)}d late</span></div>`).join('') : '<p class="calm-note">Nothing is overdue. Nūs will surface pressure here before it becomes a surprise.</p>'}`;
  const openTasks = state.data.tasks.filter((task) => !task.done).length;
  const activeRules = state.data.automations.filter((item) => item.enabled).length;
  $('#system-pulse').innerHTML = `<div class="section-kicker">This semester in Nūs</div>
    <div class="routine-row"><span class="routine-icon">▤</span><div><strong>${state.data.courses.length} course${state.data.courses.length===1?'':'s'}</strong><small>${state.data.sources.length} imported source${state.data.sources.length===1?'':'s'}</small></div><span class="routine-state">${state.data.courses.length ? 'tracked' : 'empty'}</span></div>
    <div class="routine-row"><span class="routine-icon">✓</span><div><strong>${openTasks} open task${openTasks===1?'':'s'}</strong><small>${state.data.assignments.filter((item)=>item.status==='pending').length} pending deadline${state.data.assignments.filter((item)=>item.status==='pending').length===1?'':'s'}</small></div><span class="routine-state">${openTasks ? 'live' : 'clear'}</span></div>
    <div class="routine-row"><span class="routine-icon">↻</span><div><strong>${activeRules} automation${activeRules===1?'':'s'}</strong><small>Local rules you approved</small></div><span class="routine-state">${activeRules ? 'active' : 'none'}</span></div>`;
}

function calendarItems() {
  return [
    ...state.data.assignments.filter((item) => item.due_date).map((item) => ({...item,type:'deadline',course_name:state.data.courses.find((course) => course.id === item.course_id)?.name || 'Course'})),
    ...state.data.tasks.filter((item) => item.due_date && !item.done).map((item) => ({...item,type:'task'})),
    ...((state.data.gcal_events || []).filter((item) => item.due_date).map((item) => ({...item,type:'gcal',course_name:'Google'}))),
  ];
}
function renderCalendar() {
  const cursor = state.calendarCursor;
  const year = cursor.getFullYear(), month = cursor.getMonth();
  $('#calendar-label').textContent = cursor.toLocaleDateString(undefined,{month:'long',year:'numeric'});
  const start = new Date(year,month,1), first = new Date(year,month,1-start.getDay()), today = isoDay();
  const headers = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((day) => `<div class="cal-weekday">${day}</div>`).join('');
  const items = calendarItems();
  let days = '';
  for (let index=0; index<42; index++) {
    const date = new Date(first); date.setDate(first.getDate()+index); const key=isoDay(date); const dayItems=items.filter((item)=>item.due_date===key);
    days += `<button class="cal-day${date.getMonth()!==month?' muted':''}${key===today?' today':''}${key===state.selectedDay?' selected':''}" data-day="${key}"><span class="cal-number">${date.getDate()}</span>${dayItems.slice(0,3).map((item)=>`<span class="cal-event ${item.type==='task'?'task':''}">${esc(item.title)}</span>`).join('')}</button>`;
  }
  $('#calendar-grid').innerHTML = headers + days;
  $$('.cal-day').forEach((button) => button.addEventListener('click', () => { state.selectedDay=button.dataset.day; renderCalendar(); }));
  $('#agenda-label').textContent = prettyDate(state.selectedDay);
  const selected = items.filter((item)=>item.due_date===state.selectedDay);
  $('#agenda-list').innerHTML = (selected.length ? selected.map((item)=>`<div class="agenda-item"><strong>${esc(item.title)}</strong><span>${esc(item.course_name || (item.type==='task'?'Smart task':'Deadline'))}</span></div>`).join('') : '<div class="empty-state">No commitments on this day.</div>')
    + `<button id="agenda-add" class="quiet-button" style="margin-top:12px;width:100%">+ Add to this day</button>`;
  $('#agenda-add').addEventListener('click',()=>{ $('#modal-task-due').value = state.selectedDay; $('#task-scrim').classList.remove('hidden'); $('#modal-task-title').focus(); });
}
// Zoey-style mini month in the pulse column: same data, compact cells with
// dot markers; today in a solid accent rect; a TODAY agenda strip below.
function renderMiniCalendar(){
  const host=$('#mini-calendar'); if(!host)return;
  const now=new Date(), year=now.getFullYear(), month=now.getMonth();
  const first=new Date(year,month,1-new Date(year,month,1).getDay());
  const today=isoDay();
  const items=calendarItems();
  const label=now.toLocaleDateString(undefined,{month:'long',year:'numeric'});
  let cells='';
  for(let index=0;index<42;index++){
    const date=new Date(first);date.setDate(first.getDate()+index);
    const key=isoDay(date);
    const has=items.some((item)=>item.due_date===key);
    cells+=`<button type="button" class="mini-day${date.getMonth()!==month?' muted':''}${key===today?' today':''}" data-day="${key}">${date.getDate()}${has?'<i></i>':''}</button>`;
  }
  const todayItems=items.filter((item)=>item.due_date===today).slice(0,3);
  host.innerHTML=`<div class="section-kicker">Calendar</div>
    <div class="mini-cal-head">${esc(label)}</div>
    <div class="mini-cal-grid">${['Su','Mo','Tu','We','Th','Fr','Sa'].map((d)=>`<span class="mini-wd">${d}</span>`).join('')}${cells}</div>
    <div class="mini-cal-divider"></div>
    <div class="mini-cal-today"><span class="section-kicker">Today</span>${todayItems.length?todayItems.map((item)=>`<div class="mini-agenda"><strong>${esc(item.title)}</strong><span>${esc(item.course_name||(item.type==='task'?'Smart task':'Deadline'))}</span></div>`).join(''):'<div class="mini-agenda quiet">Clear day. Nothing due.</div>'}</div>`;
  host.querySelectorAll('.mini-day').forEach((btn)=>btn.addEventListener('click',()=>{state.selectedDay=btn.dataset.day;state.calendarCursor=new Date(btn.dataset.day+'T12:00:00');setView('calendar');renderCalendar();}));
}

$('#cal-prev').addEventListener('click',()=>{state.calendarCursor.setMonth(state.calendarCursor.getMonth()-1);renderCalendar();});
$('#cal-next').addEventListener('click',()=>{state.calendarCursor.setMonth(state.calendarCursor.getMonth()+1);renderCalendar();});
$('#cal-today').addEventListener('click',()=>{state.calendarCursor=new Date();state.selectedDay=isoDay();renderCalendar();});

function renderTasks() {
  const tasks=state.data.tasks;
  $('#task-count').textContent=`${tasks.filter((task)=>!task.done).length} open`;
  $('#task-list').innerHTML = tasks.length ? tasks.map((task)=>{
    const doneSteps=task.steps.filter((step)=>step.done).length;
    return `<article class="task-card${task.done?' done':''}" data-task="${task.id}"><div class="task-head"><button class="check-button" data-task-done="${task.id}">✓</button><div><strong>${esc(task.title)}</strong><div class="task-meta">${esc(task.course_name)} · ${task.due_date?esc(relativeDue(task.due_date)):'No due date'} · ${task.estimated_minutes || 30} min</div></div><span class="task-progress">${doneSteps}/${task.steps.length}</span></div><div class="task-steps">${task.steps.map((step)=>`<div class="step-row${step.done?' done':''}"><button data-step="${step.id}">✓</button><div>${esc(step.title)}</div><span>${step.estimated_minutes}m</span></div>`).join('')}</div></article>`;
  }).join('') : '<div class="empty-state"><strong>No tasks yet.</strong>Give Nūs an outcome and it will suggest a small path you control.</div>';
  $$('[data-task-done]').forEach((button)=>button.addEventListener('click',async()=>{await api.updateTask(Number(button.dataset.taskDone),{done:button.closest('.task-card').classList.contains('done')?0:1});await load();}));
  $$('[data-step]').forEach((button)=>button.addEventListener('click',async()=>{const row=button.closest('.step-row');await api.updateTaskStep(Number(button.dataset.step),{done:row.classList.contains('done')?0:1});await load();}));
}

// Compact, prominent to-do on the dashboard: real checkboxes on real tasks.
function renderTodo(){
  const host=$('#todo-list'); if(!host)return;
  const open=state.data.tasks.filter((task)=>!task.done);
  $('#todo-heading').textContent=`Today's moves${open.length?` · ${open.length}`:''}`;
  host.innerHTML=open.length?open.slice(0,6).map((task)=>{
    const days=dayDistance(task.due_date);
    const chip=task.due_date?`<span class="todo-chip${days!==null&&days<=2?' hot':''}">${esc(relativeDue(task.due_date))}</span>`:'';
    return`<div class="todo-row"><button class="todo-check" data-task-done="${task.id}" aria-label="Mark done"></button><div class="todo-body"><strong>${esc(task.title)}</strong><span>${esc(task.course_name||'')}</span></div>${chip}</div>`;
  }).join(''):'<div class="empty-state"><strong>Nothing queued.</strong>Add a smart task or ask Nūs what to start.</div>';
  host.querySelectorAll('[data-task-done]').forEach((button)=>button.addEventListener('click',async()=>{await api.updateTask(Number(button.dataset.taskDone),{done:1});await load();showToast('Done. Nice.');}));
  $('#todo-open').onclick=()=>setView('tasks');
}

// Connections cards: email, automations, integrations, live and clickable.
function renderConnections(){
  const host=$('#connections-row'); if(!host)return;
  const outlook=state.outlook?.connected;
  const gcal=(state.data.gcal_events||[]).length>0||state.data.integrations.some((i)=>i.provider==='google_calendar'&&i.status==='connected');
  const inboxCount=(state.inbox||[]).length;
  const autos=state.data.automations.filter((a)=>a.enabled).length;
  const cards=[
    {go:'email',kicker:'Email',line:outlook?(inboxCount?`${inboxCount} worth attention`:'Inbox quiet'):'Connect Outlook',on:Boolean(outlook)},
    {go:'automations',kicker:'Automations',line:autos?`${autos} active rule${autos===1?'':'s'}`:'No rules yet',on:autos>0},
    {go:'integrations',kicker:'Integrations',line:[outlook?'Outlook':null,gcal?'Calendar':null].filter(Boolean).join(' · ')||'Nothing wired',on:Boolean(outlook||gcal)},
  ];
  host.innerHTML=cards.map((card)=>`<button type="button" class="conn-card${card.on?' on':''}" data-go="${card.go}"><span class="conn-dot"></span><div><div class="section-kicker">${card.kicker}</div><strong>${esc(card.line)}</strong></div></button>`).join('');
  host.querySelectorAll('[data-go]').forEach((button)=>button.addEventListener('click',()=>setView(button.dataset.go)));
}

async function createTaskFrom(titleEl,dueEl,minutesEl) {
  const title=titleEl.value.trim(); if(!title){showToast('Give Nūs a concrete outcome first.');return false;}
  await api.addTask({title,due_date:dueEl.value||null,estimated_minutes:Number(minutesEl.value)||60,breakdown:true});
  titleEl.value=''; await load(); showToast('Task created with a reviewable five-step path.'); return true;
}
$('#task-create').addEventListener('click',()=>createTaskFrom($('#task-title'),$('#task-due'),$('#task-minutes')));
const taskScrim=$('#task-scrim');
$('#add-task').addEventListener('click',()=>taskScrim.classList.remove('hidden'));
$('#task-close').addEventListener('click',()=>taskScrim.classList.add('hidden'));
$('#modal-task-save').addEventListener('click',async()=>{if(await createTaskFrom($('#modal-task-title'),$('#modal-task-due'),$('#modal-task-minutes')))taskScrim.classList.add('hidden');});

function renderSemester() {
  const { gpa,courses,assignments }=state.data; const overall=gpa.overall;
  const totals=gpa.courses.reduce((acc,course)=>({known:acc.known+(course.known_weight||0),assumed:acc.assumed+(course.assumed_weight||0)}),{known:0,assumed:0}); const total=totals.known+totals.assumed||1; const knownPct=Math.round(totals.known/total*100);
  $('#gpa').innerHTML=`<div class="gpa-band"><div><div class="section-kicker">Projected standing</div><div class="gpa-number">${overall==null?'—':overall.toFixed(2)}<sup>/ 4.00</sup></div></div><div class="gpa-explainer"><strong>${overall==null?'The projection begins when grading weights exist.':`${knownPct}% of this projection is grounded in graded work.`}</strong><div class="known-bar"><i style="width:${knownPct}%"></i><i class="assumed" style="width:${100-knownPct}%"></i></div>Blue is known performance. Stone is the editable assumption for ungraded work.</div></div>`;
  $('#radar-grid').innerHTML=courses.length?courses.map((course)=>{const projection=gpa.courses.find((item)=>item.course===course.name);const pending=assignments.filter((item)=>item.course_id===course.id&&item.status==='pending');const next=pending[0];return `<article class="course-lane"><div class="course-name"><strong>${esc(course.name)}</strong><small>${esc(course.code||`${course.credit_hours} credit hours`)}</small></div><div class="course-grade">${esc(projection?.letter||'—')}</div><div class="lane-track"><i class="lane-now"></i>${pending.slice(0,5).map((item,index)=>`<i class="deadline-dot${dayDistance(item.due_date)<=2?' risk':''}" style="left:${42+index*12}%"></i>`).join('')}</div><div class="course-next"><strong>${next?esc(shortDate(next.due_date)):'Clear'}</strong>${next?esc(next.title):'No pending work'}</div></article>`;}).join(''):'<div class="empty-state">Your semester has no lanes yet.</div>';
}

function sourceLabel(source){return source.title||String(source.file_path||'Imported source').split(/[\\/]/).pop();}
function sourceGlyph(source){return source.source_type==='calendar_file'?'CAL':'DOC';}
function kbMatches(text){const query=state.kb.query.trim().toLowerCase();return !query||String(text||'').toLowerCase().includes(query);}

function kbBuckets(){
  const { courses, sources, assignments } = state.data;
  const courseEntries = courses.map((course) => {
    const kids = [
      ...sources.filter((source) => source.course_id === course.id).map((source) => ({ key: `source:${source.id}`, label: sourceLabel(source), meta: source.source_type })),
      ...assignments.filter((item) => item.course_id === course.id).map((item) => ({ key: `assignment:${item.id}`, label: item.title, meta: item.due_date ? shortDate(item.due_date) : 'No date' })),
    ];
    return { key: `course:${course.id}`, label: course.name, meta: course.code || `${course.credit_hours || 0} credit hours`, children: kids };
  });
  return [
    { id: 'courses', label: 'Courses', empty: 'No courses yet', entries: courseEntries },
    { id: 'unfiled', label: 'Unfiled', empty: 'Nothing unfiled', entries: sources.filter((source) => !source.course_id).map((source) => ({ key: `source:${source.id}`, label: sourceLabel(source), meta: source.source_type, children: [] })) },
    { id: 'imports', label: 'Imports', empty: 'No imports yet', entries: sources.map((source) => ({ key: `source:${source.id}`, label: sourceLabel(source), meta: source.source_type, children: [] })) },
  ];
}

function renderSources() {
  const searching = Boolean(state.kb.query.trim());
  const tree = kbBuckets().map((bucket) => {
    const entries = bucket.entries
      .map((entry) => ({ ...entry, children: (entry.children || []).filter((kid) => kbMatches(kid.label)) }))
      .filter((entry) => !searching || kbMatches(entry.label) || entry.children.length);
    const open = searching || !state.kb.collapsed[bucket.id];
    const rows = entries.map((entry) => {
      const kidsOpen = searching || !state.kb.collapsed[entry.key];
      const hasKids = entry.children.length > 0;
      return `<div class="kb-entry">
        <button class="kb-row${state.kb.selected === entry.key ? ' selected' : ''}" data-entry="${esc(entry.key)}"${hasKids ? ` data-folder="${esc(entry.key)}"` : ''}>
          <i class="kb-caret">${hasKids ? (kidsOpen ? '⌄' : '›') : '·'}</i>
          <span><strong>${esc(entry.label)}</strong><small>${esc(entry.meta)}</small></span>
          ${hasKids ? `<em>${entry.children.length}</em>` : ''}
        </button>
        ${hasKids && kidsOpen ? `<div class="kb-children">${entry.children.map((kid) => `<button class="kb-row kb-child${state.kb.selected === kid.key ? ' selected' : ''}" data-entry="${esc(kid.key)}"><i class="kb-caret">·</i><span><strong>${esc(kid.label)}</strong><small>${esc(kid.meta)}</small></span></button>`).join('')}</div>` : ''}
      </div>`;
    }).join('');
    return `<section class="kb-bucket">
      <button class="kb-bucket-head" data-bucket="${bucket.id}"><i class="kb-caret">${open ? '⌄' : '›'}</i><span>${bucket.label}</span><em>${entries.length}</em></button>
      ${open ? `<div class="kb-bucket-body">${rows || `<p class="kb-empty">${searching ? 'No matches here' : bucket.empty}</p>`}</div>` : ''}
    </section>`;
  }).join('');
  $('#kb-tree').innerHTML = tree;
  renderKbDetail();
}

function renderKbDetail() {
  const target = $('#memory-list');
  const [kind, rawId] = String(state.kb.selected || '').split(':');
  const id = Number(rawId);
  const { courses, sources, assignments } = state.data;
  if (kind === 'course') {
    const course = courses.find((item) => item.id === id);
    if (course) {
      const work = assignments.filter((item) => item.course_id === course.id);
      const files = sources.filter((item) => item.course_id === course.id);
      target.innerHTML = `<div class="kb-detail-head"><div class="section-kicker">Course truth</div><h2>${esc(course.name)}</h2><p>${esc(course.code || 'No course code')} · ${course.credit_hours || 0} credit hours · ${esc(course.term || 'No term set')}</p></div>
        <div class="kb-detail-body">${work.length ? work.map((item) => `<article class="source-row"><div class="source-glyph">${esc((item.category || 'WK').slice(0, 2).toUpperCase())}</div><div class="source-name"><strong>${esc(item.title)}</strong><small>${esc(item.category || 'Uncategorised')}</small></div><div class="source-meta">${esc(item.due_date ? relativeDue(item.due_date) : 'No due date')}</div><div class="confidence">Confirmed</div></article>`).join('') : '<div class="empty-state">No confirmed work on this course yet.</div>'}</div>
        <p class="kb-provenance">${files.length ? `Read from ${files.map((item) => esc(sourceLabel(item))).join(', ')}.` : 'Added by hand, not read from a file.'}</p>`;
      return;
    }
  }
  if (kind === 'source') {
    const source = sources.find((item) => item.id === id);
    if (source) {
      const course = courses.find((item) => item.id === source.course_id);
      target.innerHTML = `<div class="kb-detail-head"><div class="section-kicker">Imported source</div><h2>${esc(sourceLabel(source))}</h2><p>${esc(source.source_type)} · ${course ? `filed under ${esc(course.name)}` : 'unfiled'}</p></div>
        <div class="kb-detail-body"><article class="source-row"><div class="source-glyph">${sourceGlyph(source)}</div><div class="source-name"><strong>${esc(source.file_path || sourceLabel(source))}</strong><small>Stored on this device</small></div><div class="source-meta">Imported locally</div><div class="confidence">Source file</div></article>${source.raw_text && !source.course_id ? `<button class="primary-button" data-extract-source="${source.id}" style="margin-top:12px">Read with AI: extract courses &amp; deadlines</button>` : ''}</div>
        <p class="kb-provenance">Nothing here left your machine. Delete the source and everything Nūs read from it goes with it.</p>`;
      return;
    }
  }
  if (kind === 'assignment') {
    const item = assignments.find((row) => row.id === id);
    if (item) {
      const course = courses.find((row) => row.id === item.course_id);
      target.innerHTML = `<div class="kb-detail-head"><div class="section-kicker">Confirmed deadline</div><h2>${esc(item.title)}</h2><p>${esc(course?.name || 'No course')} · ${esc(item.category || 'Uncategorised')} · ${esc(item.due_date ? relativeDue(item.due_date) : 'No due date')}</p></div>
        <p class="kb-provenance">You confirmed this in the review table. Nūs does not move a date on its own.</p>`;
      return;
    }
  }
  const total = state.data.sources.length + state.data.courses.length;
  target.innerHTML = `<div class="kb-detail-head"><div class="section-kicker">Transparent by design</div><h2>Everything Nūs knows has a source.</h2><p>Course records and personal context stay separate, local, inspectable, and removable.</p></div>
    <div class="kb-detail-body">${total ? '<div class="empty-state">Pick anything on the left to see where it came from.</div>' : '<div class="empty-state"><strong>Nūs only knows what you add.</strong>Import a syllabus, calendar, or personal export to begin.</div>'}</div>`;
}

$('#kb-search').addEventListener('input', (event) => { state.kb.query = event.target.value; renderSources(); });
$('#memory-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-extract-source]');
  if (!button) return;
  button.disabled = true; button.textContent = 'Reading…';
  const result = await api.syllabusExtract(Number(button.dataset.extractSource));
  button.disabled = false;
  if (result.error === 'no_ai') { showToast(aiError('no_ai')); setView('settings'); return; }
  if (result.error) { button.textContent = 'Read with AI: extract courses & deadlines'; showToast(aiError(result.error, result.detail)); return; }
  openReview(result.data, result.fileName, result.sourceId);
});
$('#kb-tree').addEventListener('click', (event) => {
  const bucket = event.target.closest('[data-bucket]');
  if (bucket) { state.kb.collapsed[bucket.dataset.bucket] = !state.kb.collapsed[bucket.dataset.bucket]; renderSources(); return; }
  const row = event.target.closest('[data-entry]');
  if (!row) return;
  const key = row.dataset.entry;
  if (row.dataset.folder && state.kb.selected === key) state.kb.collapsed[key] = !state.kb.collapsed[key];
  state.kb.selected = key;
  renderSources();
});

const integrationGlyphs={syllabus:'SYL',calendar_file:'ICS',folder_import:'DIR',google_calendar:'G31',canvas:'CV',blackboard:'BB',chatgpt_export:'GPT',claude_export:'CL',google_docs:'DOC',icloud_notes:'NOTE'};
function renderIntegrations() {
  $('#integration-grid').innerHTML=state.data.integrations.map((item)=>{
    const isGcal=item.provider==='google_calendar';
    const isGcalConnected=isGcal && state.data.gcal_events && state.data.gcal_events.length>=0 && item.status==='connected';
    let label,actionable,handler;
    if (item.provider==='syllabus') { label='Import syllabus'; actionable=true; handler='syllabus'; }
    else if (item.provider==='folder_import') { label='Import a folder'; actionable=true; handler='folder'; }
    else if (isGcal && state.authConfig?.googleCalendar) {
      label=isGcalConnected?'Disconnect':'Connect live';
      actionable=true;
      handler='gcal';
    } else if (isGcal||['needs_credentials','needs_admin'].includes(item.status)) {
      label='Coming soon';
      actionable=false;
      handler='soon';
    } else {
      actionable=['ready','connected'].includes(item.status);
      label=item.status==='connected'?'Import again':actionable?'Import local file':'Coming soon';
      handler='local';
    }
    return `<article class="integration-card${item.status==='connected'?' connected':''}"><div class="integration-icon">${integrationGlyphs[item.provider]||item.label.slice(0,2)}</div><h3>${esc(item.label)}</h3><p>${esc(item.detail)}</p><button class="${actionable?'ready':''}" data-integration="${item.provider}" data-handler="${handler}" data-actionable="${actionable}">${label}</button></article>`;
  }).join('');
  $$('[data-integration]').forEach((button)=>button.addEventListener('click',async()=>{
    if (button.dataset.handler==='syllabus') { importSyllabusFlow(); return; }
    if (button.dataset.handler==='folder') {
      const report=await api.importFolder();
      if(!report||report.canceled)return;
      if(report.error)return showToast(aiError(report.error,report.detail));
      await load();
      showToast(`${report.folder}: ${report.events} calendar event${report.events===1?'':'s'} imported, ${report.queued.length} file${report.queued.length===1?'':'s'} queued for review, ${report.skipped.length} skipped.`);
      return;
    }
    if (button.dataset.handler==='gcal') {
      const connected=button.textContent.includes('Disconnect');
      const result=connected?await api.gcalDisconnect():await api.gcalConnect();
      if (result.error) return showToast(result.error);
      showToast(connected?'Google Calendar disconnected.':'Google Calendar connected.');
      await load();
      return;
    }
    if(button.dataset.handler==='soon'){showToast(`${state.data.integrations.find((item)=>item.provider===button.dataset.integration)?.label||'This'} live sync ships in an update. Local file import works today.`);return;}
    if(button.dataset.actionable!=='true'){showToast(state.data.integrations.find((item)=>item.provider===button.dataset.integration)?.detail||'This connection needs credentials.');return;}
    const result=await api.importSource(button.dataset.integration);
    if(result&&!result.canceled){await load();showToast(`${result.fileName} imported locally.`);}
  }));
}
async function importDefault(){const result=await api.importSource('calendar_file');if(result&&!result.canceled){await load();showToast(`${result.imported} calendar item${result.imported===1?'':'s'} imported.`);}}
$('#import-primary').addEventListener('click',importSyllabusFlow);
$('#source-import').addEventListener('click',()=>setView('integrations'));

const AI_ERRORS={no_ai:'Connect an AI provider first. Taking you to Settings.',empty_text:'No readable text in that file. Scanned PDFs need selectable text.',bad_json:'The AI reply was not readable. Try the import again.',read_failed:'Could not read that file.',cli_timeout:'Claude Code took too long. Try again.',cli_failed:'Claude Code returned an error.',cli_spend_limit:'Your Claude subscription hit its spend limit. Add an Anthropic API key in Settings, or raise the limit in Claude Code.',cli_not_logged_in:'Claude Code is installed but signed out. Open a terminal, run "claude", then /login, or paste an Anthropic API key in Settings.',cli_spawn_failed:'Claude Code could not start.',api_failed:'The Anthropic API returned an error.',api_refused:'The AI declined this content.',api_timeout:'The API call timed out. Try again.',api_network:'Network problem reaching Anthropic.',unexpected_reply:'The provider answered, but not as expected.',source_missing:'That import is no longer on file.',course_name_required:'The course needs a name.',target_not_found:'I could not find that item. Try its exact name.',incomplete_command:'I need a bit more: which item, and what date?',unknown_intent:'That request did not survive the trip. Try again.'};
function aiError(code,detail){const base=AI_ERRORS[code]||`Import failed (${code}).`;return detail?`${base} (${String(detail).slice(0,120)})`:base;}

async function importSyllabusFlow(){
  showToast('Reading the syllabus…');
  const result=await api.syllabusImport();
  if(!result||result.canceled)return;
  if(result.error==='no_ai'||result.error==='cli_not_logged_in'){state.pendingSourceId=result.sourceId||null;showToast(aiError(result.error));setView('settings');return;}
  if(result.error){showToast(aiError(result.error,result.detail));return;}
  openReview(result.data,result.fileName,result.sourceId);
}

const reviewScrim=$('#syllabus-scrim');
function openReview(data,fileName,sourceId){
  state.review={sourceId,course:{...data.course},weights:data.grade_weights.map((row)=>({...row})),assignments:data.assignments.map((row)=>({...row}))};
  $('#review-heading').textContent=`Check what Nūs read from ${fileName}`;
  $('#rev-course-name').value=state.review.course.name||'';
  $('#rev-course-code').value=state.review.course.code||'';
  $('#rev-course-hours').value=state.review.course.credit_hours??'';
  $('#rev-course-term').value=state.review.course.term||'';
  $('#rev-status').textContent='';
  renderReviewTables();
  reviewScrim.classList.remove('hidden');
}
function renderReviewTables(){
  $('#rev-weights').innerHTML=state.review.weights.map((row,index)=>`<tr><td><input data-kind="weight" data-idx="${index}" data-field="category" value="${esc(row.category)}" /></td><td><input data-kind="weight" data-idx="${index}" data-field="weight_pct" type="number" min="0" max="100" value="${esc(row.weight_pct)}" /></td><td><button class="row-delete" data-del-weight="${index}" title="Remove">×</button></td></tr>`).join('')||'<tr><td colspan="3" class="sheet-note">No grade weights found. Add them if your syllabus lists grading percentages.</td></tr>';
  $('#rev-assignments').innerHTML=state.review.assignments.map((row,index)=>`<tr><td><input data-kind="assignment" data-idx="${index}" data-field="title" value="${esc(row.title)}" /></td><td><input data-kind="assignment" data-idx="${index}" data-field="due_date" type="date" value="${esc(row.due_date||'')}" /></td><td><input data-kind="assignment" data-idx="${index}" data-field="category" value="${esc(row.category||'')}" list="rev-category-options" /></td><td><button class="row-delete" data-del-assignment="${index}" title="Remove">×</button></td></tr>`).join('')||'<tr><td colspan="4" class="sheet-note">No assignments found. Add the ones that matter.</td></tr>';
  $('#rev-category-options').innerHTML=state.review.weights.map((row)=>`<option value="${esc(row.category)}"></option>`).join('');
}
reviewScrim.addEventListener('input',(event)=>{
  const input=event.target; if(!input.dataset.kind)return;
  const list=input.dataset.kind==='weight'?state.review.weights:state.review.assignments;
  const row=list[Number(input.dataset.idx)]; if(!row)return;
  row[input.dataset.field]=input.dataset.field==='weight_pct'?Number(input.value):input.value;
});
reviewScrim.addEventListener('click',(event)=>{
  const button=event.target.closest('button'); if(!button)return;
  if(button.id==='review-close'){reviewScrim.classList.add('hidden');return;}
  if(button.dataset.delWeight!=null){state.review.weights.splice(Number(button.dataset.delWeight),1);renderReviewTables();return;}
  if(button.dataset.delAssignment!=null){state.review.assignments.splice(Number(button.dataset.delAssignment),1);renderReviewTables();return;}
  if(button.id==='rev-add-weight'){state.review.weights.push({category:'',weight_pct:0});renderReviewTables();return;}
  if(button.id==='rev-add-assignment'){state.review.assignments.push({title:'',due_date:null,category:null});renderReviewTables();return;}
});
$('#rev-confirm').addEventListener('click',async()=>{
  const review=state.review;
  review.course={name:$('#rev-course-name').value.trim(),code:$('#rev-course-code').value.trim()||null,credit_hours:$('#rev-course-hours').value===''?null:Number($('#rev-course-hours').value),term:$('#rev-course-term').value.trim()||null};
  if(!review.course.name){$('#rev-status').textContent='The course needs a name.';return;}
  const badDate=review.assignments.find((row)=>row.due_date&&!/^\d{4}-\d{2}-\d{2}$/.test(row.due_date));
  if(badDate){$('#rev-status').textContent=`Check the date on “${badDate.title||'an assignment'}”.`;return;}
  review.weights=review.weights.filter((row)=>row.category.trim()&&Number.isFinite(Number(row.weight_pct)));
  review.assignments=review.assignments.filter((row)=>String(row.title||'').trim());
  $('#rev-status').textContent='Saving…';
  const result=await api.syllabusConfirm({sourceId:review.sourceId,course:review.course,grade_weights:review.weights,assignments:review.assignments});
  if(result.error){$('#rev-status').textContent=aiError(result.error,result.detail);return;}
  reviewScrim.classList.add('hidden');
  await load();
  showToast(`${review.course.name}: ${result.assignments} assignment${result.assignments===1?'':'s'} and ${result.weights} grade weight${result.weights===1?'':'s'} saved.`);
});

const GPA_PRESETS={'plus-minus':[[93,'A',4],[90,'A-',3.7],[87,'B+',3.3],[83,'B',3],[80,'B-',2.7],[77,'C+',2.3],[73,'C',2],[70,'C-',1.7],[67,'D+',1.3],[63,'D',1],[60,'D-',0.7],[0,'F',0]],'whole-letter':[[90,'A',4],[80,'B',3],[70,'C',2],[60,'D',1],[0,'F',0]]};
function scaleRows(){return state.gpaScale||(state.data.preferences.gpa_scale?state.data.preferences.gpa_scale.map((r)=>({...r})):GPA_PRESETS['plus-minus'].map(([min,letter,points])=>({min,letter,points})));}
function renderGpaScale(){
  state.gpaScale=scaleRows();
  $('#gpa-scale-rows').innerHTML=state.gpaScale.map((row,index)=>`<tr><td><input data-scale-idx="${index}" data-scale-field="letter" value="${esc(row.letter)}" /></td><td><input data-scale-idx="${index}" data-scale-field="min" type="number" min="0" max="100" value="${esc(row.min)}" /></td><td><input data-scale-idx="${index}" data-scale-field="points" type="number" min="0" max="5" step="0.1" value="${esc(row.points)}" /></td><td><button class="row-delete" data-scale-del="${index}">×</button></td></tr>`).join('');
}
$('#gpa-scale-card').addEventListener('input',(event)=>{const input=event.target;if(input.dataset.scaleIdx==null)return;const row=state.gpaScale[Number(input.dataset.scaleIdx)];if(!row)return;row[input.dataset.scaleField]=input.dataset.scaleField==='letter'?input.value:Number(input.value);});
$('#gpa-scale-card').addEventListener('click',async(event)=>{
  const button=event.target.closest('button'); if(!button)return;
  if(button.dataset.scaleDel!=null){state.gpaScale.splice(Number(button.dataset.scaleDel),1);renderGpaScale();return;}
  if(button.id==='gpa-scale-add'){state.gpaScale.push({min:0,letter:'',points:0});renderGpaScale();return;}
  if(button.id==='gpa-scale-save'){
    const rows=state.gpaScale.filter((r)=>String(r.letter).trim()&&Number.isFinite(Number(r.min))&&Number.isFinite(Number(r.points)));
    if(!rows.length){$('#gpa-scale-status').textContent='Add at least one row.';return;}
    await api.setPreference('gpa_scale',rows);
    $('#gpa-scale-status').textContent='Saved. Projections now use this scale.';
    await load();
  }
});
$('#gpa-preset').addEventListener('change',(event)=>{const preset=GPA_PRESETS[event.target.value];if(!preset)return;state.gpaScale=preset.map(([min,letter,points])=>({min,letter,points}));renderGpaScale();event.target.value='';});

async function renderAiState(){
  const status=await api.aiStatus();
  const badge=$('#ai-badge');
  const form=$('#ai-key-form');
  // The key form stays available even when the CLI is present: an installed but
  // signed-out CLI would otherwise leave the user with no way to configure AI.
  form.classList.remove('hidden');
  $('#ai-key-clear').classList.toggle('hidden',!status.apiKey);
  if(status.cli){
    $('#ai-title').textContent=status.apiKey?'Claude Code detected (API key as backup)':'Claude Code detected';
    $('#ai-copy').textContent='Syllabus reading runs through your Claude Code subscription. If Claude Code is signed out, run "claude" in a terminal and use /login, or paste an Anthropic API key below as a fallback.';
    badge.textContent='Ready';badge.classList.add('good');
  }else if(status.apiKey){
    $('#ai-title').textContent='Anthropic API key saved';
    $('#ai-copy').textContent='The key is encrypted on this device and used only when you import a syllabus.';
    badge.textContent='Ready';badge.classList.add('good');
  }else{
    $('#ai-title').textContent='Connect an AI to read syllabi';
    $('#ai-copy').textContent='Install Claude Code (detected automatically), or paste an Anthropic API key. Without one, imports still work for calendar .ics files.';
    badge.textContent='Not set';badge.classList.remove('good');
  }
}
$('#ai-key-save').addEventListener('click',async()=>{
  const value=$('#ai-key').value;
  $('#ai-key').value='';
  if(!value.trim())return showToast('Paste a key first.');
  const result=await api.aiSetKey(value);
  if(result.error)return showToast('That key looks empty.');
  $('#ai-test-result').textContent='Key saved.';
  await renderAiState();
  if(state.pendingSourceId){
    const retry=await api.syllabusExtract(state.pendingSourceId);
    state.pendingSourceId=null;
    if(!retry.error)openReview(retry.data,retry.fileName,retry.sourceId);
  }
});
$('#ai-test').addEventListener('click',async()=>{
  const button=$('#ai-test');
  button.disabled=true;$('#ai-test-result').textContent='Testing…';
  const result=await api.aiTest();
  button.disabled=false;
  $('#ai-test-result').textContent=result.ok?'Provider answered. You are set.':aiError(result.error,result.detail);
});
$('#ai-key-clear').addEventListener('click',async()=>{
  await api.aiClearKey();
  $('#ai-test-result').textContent='Key removed.';
  renderAiState();
});

function renderAutomations() {
  const signals=state.data.repeated_signals;
  $('#automation-suggestions').innerHTML=signals.length?signals.map((signal)=>`<div class="suggestion-card"><div><strong>${esc(signal.example_title)} keeps appearing.</strong><span>${signal.occurrences} similar tasks found. Turn the pattern into a weekly local rule?</span></div><button class="quiet-button" data-suggest="${esc(signal.example_title)}">Review rule</button></div>`).join(''):'<div class="empty-state">Nūs will suggest a rule after it sees the same kind of task twice. It never creates one silently.</div>';
  $$('[data-suggest]').forEach((button)=>button.addEventListener('click',()=>{$('#automation-title').value=button.dataset.suggest;$('#automation-scrim').classList.remove('hidden');}));
  $('#automation-list').innerHTML=state.data.automations.length?state.data.automations.map((item)=>`<article class="automation-row"><div class="automation-glyph">↻</div><div><strong>${esc(item.name)}</strong><small>${esc(item.trigger_type)} → create local task</small></div><div class="automation-stat">${item.run_count} run${item.run_count===1?'':'s'}</div><button class="toggle-button${item.enabled?' on':''}" data-automation-toggle="${item.id}">${item.enabled?'Active':'Paused'}</button></article>`).join(''):'<div class="empty-state"><strong>No automation rules yet.</strong>Start with one recurring study task, not a general workflow maze.</div>';
  $$('[data-automation-toggle]').forEach((button)=>button.addEventListener('click',async()=>{await api.updateAutomation(Number(button.dataset.automationToggle),{enabled:button.classList.contains('on')?0:1});await load();}));
}
const automationScrim=$('#automation-scrim');
$('#new-automation').addEventListener('click',()=>automationScrim.classList.remove('hidden'));
$('#automation-close').addEventListener('click',()=>automationScrim.classList.add('hidden'));
$('#automation-save').addEventListener('click',async()=>{const title=$('#automation-title').value.trim();if(!title)return showToast('Name the recurring task.');const trigger=$('#automation-trigger').value;const next=new Date();next.setDate(next.getDate()+(trigger==='daily'?1:7));await api.addAutomation({name:title,trigger_type:trigger,trigger:{timezone:Intl.DateTimeFormat().resolvedOptions().timeZone},action_type:'create_task',action:{title,estimated_minutes:Number($('#automation-minutes').value)||45},next_run_at:next.toISOString()});automationScrim.classList.add('hidden');await load();showToast('Local automation approved.');});

function courseStatus(course){
  const pending=state.data.assignments.filter((item)=>item.course_id===course.id&&item.status==='pending');
  const soonest=pending.map((item)=>dayDistance(item.due_date)).filter((days)=>days!==null).sort((a,b)=>a-b)[0];
  if(soonest===undefined)return['clear','ok'];
  if(soonest<0)return['overdue','risk'];
  if(soonest<=2)return['at risk','risk'];
  return['on track','ok'];
}
function renderBrain() {
  const stage=$('#brain-stage'); if(!stage)return;
  let shouldFitViewport=false;
  const nodes=[]; const edges=[];
  nodes.push({id:'nus',type:'core',label:'Nūs',meta:'Semester intelligence',status:state.data.courses.length?'live':'empty',tone:'ok'});
  state.data.courses.forEach((course,index)=>{const[status,tone]=courseStatus(course);nodes.push({id:`c${course.id}`,type:'course',label:course.name,meta:course.code||'Course',status,tone});edges.push(['nus',`c${course.id}`]);});
  state.data.sources.slice(0,8).forEach((source,index)=>{const id=`s${source.id}`;nodes.push({id,type:'source',label:source.title||'Imported source',meta:source.source_type,status:'imported',tone:'ok'});const courseId=source.course_id?`c${source.course_id}`:'nus';edges.push([courseId,id]);});
  state.data.tasks.filter((task)=>!task.done).slice(0,12).forEach((task,index)=>{const id=`t${task.id}`;const days=dayDistance(task.due_date);nodes.push({id,type:'task',label:task.title,meta:task.due_date?relativeDue(task.due_date):'Open task',status:days!==null&&days<=2?'due soon':'open',tone:days!==null&&days<=2?'risk':'ok'});const course=state.data.courses.find((item)=>item.name===task.course_name);edges.push([course?`c${course.id}`:'nus',id]);});
  const STOPWORDS=new Set(['the','and','for','with','from','into','your','this','that','week','weekly','chapter','exam','homework','assignment','review','study','notes','file','import','course']);
  const nodeTokens=(node)=>new Set(String(node.label).toLowerCase().split(/[^a-z0-9]+/).filter((w)=>w.length>3&&!STOPWORDS.has(w)));
  const structural=new Set(edges.map(([a,b])=>`${a}|${b}`).concat(edges.map(([a,b])=>`${b}|${a}`)));
  const simEdges=[];
  const linkable=nodes.filter((node)=>node.type!=='core');
  for(let i=0;i<linkable.length&&simEdges.length<12;i++){
    const tokensA=nodeTokens(linkable[i]);
    if(!tokensA.size)continue;
    for(let j=i+1;j<linkable.length&&simEdges.length<12;j++){
      if(structural.has(`${linkable[i].id}|${linkable[j].id}`))continue;
      const shared=[...nodeTokens(linkable[j])].filter((w)=>tokensA.has(w));
      if(shared.length)simEdges.push([linkable[i].id,linkable[j].id]);
    }
  }
  state.brain.graph={nodes,edges,simEdges};
  const saved=state.data.preferences.brain_layout||{}; state.brain.positions={...saved,...state.brain.positions};
  if(!state.brain.viewportLoaded){
    const viewport=state.data.preferences.brain_viewport;
    if(viewport&&Number.isFinite(viewport.scale)&&Number.isFinite(viewport.offsetX)&&Number.isFinite(viewport.offsetY)){
      state.brain.scale=viewport.scale;
      state.brain.offsetX=viewport.offsetX;
      state.brain.offsetY=viewport.offsetY;
    }else{
      state.brain.scale=state.data.preferences.brain_scale||1;
      shouldFitViewport=true;
    }
    state.brain.viewportLoaded=true;
  }
  nodes.forEach((node,index)=>{if(!state.brain.positions[node.id]){const ring=node.type==='core'?0:node.type==='course'?180:330;const siblings=nodes.filter((item)=>item.type===node.type);const at=siblings.findIndex((item)=>item.id===node.id);const offsets={course:-.8,source:1.9,task:4.3,core:0};const angle=(at/Math.max(1,siblings.length))*Math.PI*2+offsets[node.type];state.brain.positions[node.id]={x:stage.clientWidth/2+(ring?Math.cos(angle)*ring:0)-75,y:stage.clientHeight/2+(ring?Math.sin(angle)*ring:0)-35};}});
  $('#brain-nodes').innerHTML=nodes.map((node)=>{const pos=state.brain.positions[node.id];return `<article class="brain-node ${node.type}" data-node="${node.id}" style="left:${pos.x}px;top:${pos.y}px"><div class="node-top"><small>${node.type}</small><b class="node-status ${node.tone}">${esc(node.status)}</b></div><strong>${esc(node.label)}</strong><span>${esc(node.meta)}</span></article>`;}).join('');
  applyBrainScale();
  drawBrainEdges(edges); bindBrainDrag(edges);
  if(shouldFitViewport)fitBrainViewport(false,false);
}
// Semantic-zoom thresholds get hysteresis: detail turns ON above 0.78 and OFF
// below 0.72 (sim edges 0.93/0.87), so hovering the boundary can't flicker.
function brainNodeVisible(id){
  if(state.brain.detailOn===undefined)state.brain.detailOn=state.brain.scale>0.75;
  if(!state.brain.detailOn)  {
    const node=(state.brain.graph?.nodes||[]).find((n)=>n.id===id);
    return !node||node.type==='core'||node.type==='course';
  }
  return true;
}
function updateBrainThresholds(){
  const s=state.brain.scale;
  if(state.brain.detailOn===undefined)state.brain.detailOn=s>0.75;
  else if(state.brain.detailOn&&s<0.72)state.brain.detailOn=false;
  else if(!state.brain.detailOn&&s>0.78)state.brain.detailOn=true;
  if(state.brain.simOn===undefined)state.brain.simOn=s>=0.9;
  else if(state.brain.simOn&&s<0.87)state.brain.simOn=false;
  else if(!state.brain.simOn&&s>0.93)state.brain.simOn=true;
}
// Pan only moves the world transform; nothing inside the world changes.
// Scale changes additionally re-resolve node visibility and edge paths.
function applyBrainTransform(){
  const world=$('#brain-world');
  world.style.transform=`translate(${state.brain.offsetX}px, ${state.brain.offsetY}px) scale(${state.brain.scale})`;
  world.style.transformOrigin='0 0';
  $('#zoom-label').textContent=`${Math.round(state.brain.scale*100)}%`;
}
function applyBrainScale(){
  applyBrainTransform();
  updateBrainThresholds();
  const scale=state.brain.scale;
  $$('.brain-node').forEach((node)=>{node.style.display=brainNodeVisible(node.dataset.node)?'':'none';node.classList.toggle('detailed',scale>=1.1);});
  if(state.brain.graph)scheduleBrainEdges();
}
let brainViewportSaveTimer=null;
function persistBrainViewport(){
  clearTimeout(brainViewportSaveTimer);
  brainViewportSaveTimer=setTimeout(()=>api.setPreference('brain_viewport',{
    scale:state.brain.scale,
    offsetX:Math.round(state.brain.offsetX),
    offsetY:Math.round(state.brain.offsetY),
  }),180);
}
function setBrainScale(next,anchor){
  const stage=$('#brain-stage');
  const previous=state.brain.scale;
  const scale=Math.min(1.6,Math.max(0.5,Math.round(next*1000)/1000));
  const point=anchor||{x:stage.clientWidth/2,y:stage.clientHeight/2};
  const worldX=(point.x-state.brain.offsetX)/previous;
  const worldY=(point.y-state.brain.offsetY)/previous;
  state.brain.scale=scale;
  state.brain.offsetX=point.x-worldX*scale;
  state.brain.offsetY=point.y-worldY*scale;
  applyBrainScale();
  persistBrainViewport();
}
// Wheel zoom eases toward a target instead of applying each tick raw: the
// scale lerps ~28% of the remaining distance per frame, anchored under the
// cursor, so fast scrolling feels fluid instead of stepped.
let brainZoomAnim=null;
function glideBrainScale(target,anchor){
  target=Math.min(1.6,Math.max(0.5,target));
  brainZoomAnim={target,anchor};
  requestAnimationFrame(function step(){
    if(!brainZoomAnim)return;
    const diff=brainZoomAnim.target-state.brain.scale;
    if(Math.abs(diff)<0.004){setBrainScale(brainZoomAnim.target,brainZoomAnim.anchor);brainZoomAnim=null;return;}
    setBrainScale(state.brain.scale+diff*0.28,brainZoomAnim.anchor);
    requestAnimationFrame(step);
  });
}
$('#zoom-in').addEventListener('click',()=>glideBrainScale((brainZoomAnim?.target??state.brain.scale)+0.1));
$('#zoom-out').addEventListener('click',()=>glideBrainScale((brainZoomAnim?.target??state.brain.scale)-0.1));
function drawBrainEdges(edges){
  const svg=$('#brain-edges');
  const path=([a,b],cls)=>{const start=state.brain.positions[a],end=state.brain.positions[b];if(!start||!end||!brainNodeVisible(a)||!brainNodeVisible(b))return'';return `<path class="${cls}" d="M ${start.x+72} ${start.y+32} C ${(start.x+end.x)/2} ${start.y+32}, ${(start.x+end.x)/2} ${end.y+32}, ${end.x+72} ${end.y+32}"/>`;};
  const simEdges=state.brain.simOn?(state.brain.graph?.simEdges||[]):[];
  svg.innerHTML=edges.map((edge)=>path(edge,'brain-edge')).join('')+simEdges.map((edge)=>path(edge,'brain-edge sim')).join('');
}
// Edge redraws are coalesced to one per animation frame: dragging a node fires
// pointermove far faster than 60Hz and each redraw rebuilds the SVG innerHTML.
let brainEdgeFrame=null;
function scheduleBrainEdges(){
  if(brainEdgeFrame||!state.brain.graph)return;
  brainEdgeFrame=requestAnimationFrame(()=>{brainEdgeFrame=null;drawBrainEdges(state.brain.graph.edges);});
}
function bindBrainDrag(edges){
  $$('.brain-node').forEach((node)=>{
    node.onpointerdown=(event)=>{
      if(event.button!==0)return;
      event.preventDefault();
      event.stopPropagation();
      node.classList.add('dragging');
      node.setPointerCapture(event.pointerId);
      const id=node.dataset.node,start={x:event.clientX,y:event.clientY},origin={...state.brain.positions[id]};
      node.onpointermove=(move)=>{
        const zoom=state.brain.scale||1;
        state.brain.positions[id]={x:origin.x+(move.clientX-start.x)/zoom,y:origin.y+(move.clientY-start.y)/zoom};
        node.style.left=`${state.brain.positions[id].x}px`;
        node.style.top=`${state.brain.positions[id].y}px`;
        scheduleBrainEdges();
      };
      const finish=async()=>{
        node.classList.remove('dragging');
        node.onpointermove=null;
        node.onpointerup=null;
        node.onpointercancel=null;
        await api.setPreference('brain_layout',state.brain.positions);
      };
      node.onpointerup=finish;
      node.onpointercancel=finish;
    };
  });
}
function fitBrainViewport(persist=true,animate=true){
  const stage=$('#brain-stage');
  const positions=Object.values(state.brain.positions);
  if(!positions.length)return;
  const minX=Math.min(...positions.map((p)=>p.x));
  const minY=Math.min(...positions.map((p)=>p.y));
  const maxX=Math.max(...positions.map((p)=>p.x+190));
  const maxY=Math.max(...positions.map((p)=>p.y+82));
  const width=Math.max(1,maxX-minX),height=Math.max(1,maxY-minY),padding=74;
  const toScale=Math.min(1.2,Math.max(.5,Math.min((stage.clientWidth-padding*2)/width,(stage.clientHeight-padding*2)/height)));
  const toX=(stage.clientWidth-width*toScale)/2-minX*toScale;
  const toY=(stage.clientHeight-height*toScale)/2-minY*toScale;
  if(!animate){
    state.brain.scale=toScale;state.brain.offsetX=toX;state.brain.offsetY=toY;
    applyBrainScale();
    if(persist)persistBrainViewport();
    return;
  }
  // Center map glides home over ~280ms instead of jumping.
  const from={scale:state.brain.scale,x:state.brain.offsetX,y:state.brain.offsetY};
  const t0=performance.now();
  brainZoomAnim=null;
  requestAnimationFrame(function step(now){
    const t=Math.min(1,(now-t0)/280);
    const e=1-Math.pow(1-t,3); // ease-out cubic
    state.brain.scale=from.scale+(toScale-from.scale)*e;
    state.brain.offsetX=from.x+(toX-from.x)*e;
    state.brain.offsetY=from.y+(toY-from.y)*e;
    applyBrainScale();
    if(t<1)requestAnimationFrame(step);
    else if(persist)persistBrainViewport();
  });
}
const brainStage=$('#brain-stage');
let brainPan=null;
brainStage.addEventListener('pointerdown',(event)=>{
  if(event.button!==0||event.target.closest('.brain-node,button'))return;
  event.preventDefault();
  brainStage.setPointerCapture(event.pointerId);
  brainStage.classList.add('dragging');
  brainPan={x:event.clientX,y:event.clientY,offsetX:state.brain.offsetX,offsetY:state.brain.offsetY};
});
brainStage.addEventListener('pointermove',(event)=>{
  if(!brainPan)return;
  state.brain.offsetX=brainPan.offsetX+event.clientX-brainPan.x;
  state.brain.offsetY=brainPan.offsetY+event.clientY-brainPan.y;
  applyBrainTransform(); // pan never changes what is visible, only where it sits
});
function finishBrainPan(){if(!brainPan)return;brainPan=null;brainStage.classList.remove('dragging');persistBrainViewport();}
brainStage.addEventListener('pointerup',finishBrainPan);
brainStage.addEventListener('pointercancel',finishBrainPan);
brainStage.addEventListener('wheel',(event)=>{
  event.preventDefault();
  const rect=brainStage.getBoundingClientRect();
  const direction=Math.exp(-event.deltaY*.0015);
  const base=brainZoomAnim?.target??state.brain.scale;
  glideBrainScale(base*direction,{x:event.clientX-rect.left,y:event.clientY-rect.top});
},{passive:false});
$('#brain-fit').addEventListener('click',()=>fitBrainViewport());

async function renderSettings(){
  const status=await api.bridgeStatus();
  $('#bridge-title').textContent=status.connected?'Companion context is linked':'Companion context is offline';
  $('#bridge-copy').textContent=status.connected?`Shared snapshot refreshed ${new Date(status.updated_at).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'})}. The Companion never opens the database.`:'Open Nūs once to refresh the shared snapshot.';
  $('#bridge-badge').textContent=status.connected?'Linked':'Offline';
  $('#bridge-badge').classList.toggle('good',status.connected);
  renderAuthState();
  renderSyncState();
  renderAiState();
  renderCompanionAiState();
  renderGpaScale();
  renderStorage();
}

// The Companion's provider key, managed from the desktop so the overlay is
// usable without hunting for its gear icon.
async function renderCompanionAiState(){
  const badge=$('#companion-ai-badge'); if(!badge)return;
  const status=await api.companionAiStatus?.().catch(()=>null);
  const has=Boolean(status?.keys?.gemini||status?.keys?.openai);
  badge.textContent=has?'Key saved':'Needs a key';
  badge.classList.toggle('good',has);
  $('#companion-ai-title').textContent=has?'The Companion is ready to answer':'The on-screen Knot needs its own key';
  $('#companion-ai-clear')?.classList.toggle('hidden',!status?.keys?.gemini);
}
$('#companion-ai-save')?.addEventListener('click',async()=>{
  const input=$('#companion-ai-key'); const key=(input.value||'').trim();
  if(!key){$('#companion-ai-result').textContent='Paste a key first.';return;}
  const result=await api.companionAiSetKey({provider:'gemini',key});
  input.value='';
  $('#companion-ai-result').textContent=result?.error?'That key was not accepted.':'Saved. The Knot can answer now.';
  renderCompanionAiState();
});
$('#companion-ai-clear')?.addEventListener('click',async()=>{
  await api.companionAiClearKey('gemini');
  $('#companion-ai-result').textContent='Key removed.';
  renderCompanionAiState();
});

// Settings sidebar: each link scrolls its card into view and lights up.
$$('.settings-link').forEach((link)=>link.addEventListener('click',()=>{
  $$('.settings-link').forEach((l)=>l.classList.toggle('active',l===link));
  const card=document.getElementById(link.dataset.card);
  if(card){card.scrollIntoView({behavior:'smooth',block:'start'});card.classList.add('flash');setTimeout(()=>card.classList.remove('flash'),900);}
}));

function formatBytes(bytes){if(bytes<1024)return`${bytes} B`;if(bytes<1048576)return`${(bytes/1024).toFixed(1)} KB`;if(bytes<1073741824)return`${(bytes/1048576).toFixed(1)} MB`;return`${(bytes/1073741824).toFixed(2)} GB`;}
async function renderStorage(){
  const status=await api.storageStatus().catch(()=>null); if(!status)return;
  const used=status.dbBytes;
  const pct=Math.min(100,(used/status.capBytes)*100);
  // Small mirror in the rail, so the number is visible without opening Settings.
  const railValue=$('#rail-storage-value'), railBar=$('#rail-storage-bar');
  if(railValue) railValue.textContent=formatBytes(used);
  if(railBar) railBar.style.width=`${Math.max(pct,2)}%`;
  $('#rail-storage')?.classList.toggle('full',pct>80);
  if(!$('#storage-title'))return;
  $('#storage-title').textContent=`${formatBytes(used)} of ${formatBytes(status.capBytes)} local space`;
  $('#storage-copy').textContent=`Database ${formatBytes(status.dbBytes)}, of which imported source text is ${formatBytes(status.sourceBytes)}. Everything stays on this device. Back it up, export it, or delete it any time.`;
  $('#storage-bar').style.width=`${Math.max(pct,1)}%`;
  const badge=$('#storage-badge');
  if(pct>80){badge.textContent='Nearly full';badge.classList.remove('good');}
  else{badge.textContent=formatBytes(used);badge.classList.add('good');}
}

async function renderAuthState() {
  const [authConfig, session] = await Promise.all([api.authConfig(), api.authSession()]);
  const signedIn = Boolean(session && session.user);
  const email = session?.user?.email || '';
  $('#auth-form').classList.toggle('hidden', signedIn);
  $('#auth-signedin').classList.toggle('hidden', !signedIn);
  if (signedIn) {
    $('#auth-user-email').textContent = email;
    $('#auth-title').textContent = 'Signed in';
    $('#auth-copy').textContent = 'Local SQLite stays the source of truth. Supabase holds your identity and (only if you turn on cloud sync) your bounded snapshot.';
    $('#auth-badge').textContent = 'Signed in';
    $('#auth-badge').classList.add('good');
    $('#rail-name').textContent = email.split('@')[0];
    $('#rail-avatar').textContent = email.slice(0, 1).toUpperCase();
    $('#rail-mode').textContent = 'Signed in';
    $('#settings-name').textContent = email.split('@')[0];
    $('#settings-email').textContent = email;
  } else {
    $('#auth-title').textContent = authConfig.supabase ? 'Sign in to Nūs' : 'Accounts are coming soon';
    $('#auth-copy').textContent = authConfig.supabase
      ? 'Google or email. Local mode stays available if you skip sign-in.'
      : 'Nūs runs fully on this device today. Optional accounts and cross-device sync ship in an update. Nothing you add now is lost.';
    $('#auth-badge').textContent = 'Local';
    $('#auth-badge').classList.remove('good');
    $('#rail-name').textContent = 'You';
    $('#rail-avatar').textContent = 'N';
    $('#rail-mode').textContent = 'Local profile';
    $('#settings-name').textContent = 'Local';
    $('#settings-email').textContent = 'Not signed in';
    if (!authConfig.supabase) {
      $('#auth-form').classList.add('hidden');
    }
  }
}

$('#auth-login').addEventListener('click', async () => {
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  if (!email || !password) return showToast('Enter email and password.');
  const result = await api.loginEmail(email, password);
  if (result.error) return showToast(result.error);
  showToast('Signed in.');
  renderAuthState();
  renderSyncState();
});
$('#auth-signup').addEventListener('click', async () => {
  const email = $('#auth-email').value.trim();
  const password = $('#auth-password').value;
  if (!email || !password) return showToast('Enter email and password.');
  if (password.length < 8) return showToast('Password must be at least 8 characters.');
  const result = await api.signupEmail(email, password);
  if (result.error) return showToast(result.error);
  showToast(result.session ? 'Account created and signed in.' : 'Check your email to confirm the account.');
  renderAuthState();
});
$('#auth-google').addEventListener('click', async () => {
  const result = await api.loginGoogle();
  if (result.error) return showToast(result.error);
  showToast('Continuing in your browser. Return to Nūs after approving.');
});
$('#auth-logout').addEventListener('click', async () => {
  await api.logout();
  showToast('Signed out. Cloud data removed.');
  renderAuthState();
  renderSyncState();
});

async function renderSyncState() {
  const status = await api.syncStatus();
  const toggle = $('#sync-toggle');
  const label = $('#sync-label');
  const badge = $('#sync-badge');
  const statusText = $('#sync-status');
  toggle.disabled = !status.configured || !status.authenticated;
  toggle.checked = status.enabled;
  if (!status.configured) {
    label.textContent = 'Supabase not configured';
    badge.textContent = 'Off';
    badge.classList.remove('good');
    statusText.textContent = '';
  } else if (!status.authenticated) {
    label.textContent = 'Sign in to enable cloud sync';
    badge.textContent = 'Off';
    badge.classList.remove('good');
    statusText.textContent = '';
  } else {
    label.textContent = status.enabled ? 'Cloud sync is on' : 'Cloud sync is off';
    badge.textContent = status.enabled ? 'On' : 'Off';
    badge.classList.toggle('good', status.enabled);
    statusText.textContent = status.enabled ? 'Bounded snapshot syncs to your Supabase row.' : '';
  }
}
$('#sync-toggle').addEventListener('change', async (event) => {
  const result = await api.syncSetEnabled(event.target.checked);
  if (result.error) { showToast(result.error); event.target.checked = !event.target.checked; }
  renderSyncState();
});
$('#sync-delete').addEventListener('click', async () => {
  const result = await api.syncDeleteCloud();
  if (result.error) return showToast(result.error);
  showToast('Cloud data deleted.');
  renderSyncState();
});

async function renderEmail() {
  renderEmailAccounts(); // Gmail works with no connection, so this always renders
  const config = await api.authConfig();
  const status = $('#outlook-status');
  const connectBtn = $('#outlook-connect');
  const refreshBtn = $('#outlook-refresh-style');
  if (!config.outlook) {
    status.textContent = 'Live Outlook connection is coming soon. The professor email drafter below works today: it writes locally and you copy the draft out.';
    connectBtn.textContent = 'Coming soon';
    connectBtn.disabled = true;
    return;
  }
  const result = await api.outlookStatus();
  if (result.connected) {
    status.textContent = `Connected as ${result.email || 'your Outlook account'}.`;
    connectBtn.textContent = 'Disconnect';
    refreshBtn.disabled = false;
    const profile = await api.styleProfile();
    $('#style-summary').innerHTML = profile && profile.ready
      ? `<strong>Email style ready.</strong> ${profile.exemplars || 0} exemplars, formality ${profile.formality || 'auto'}, avg sentence ${profile.avgSentenceWords || '—'} words.`
      : 'No style profile yet. Click "Refresh writing style" to pull your last ~50 sent emails and build a local fingerprint.';
  } else {
    status.textContent = 'Not connected. Connect Outlook to read your sent mail and send drafts you approve.';
    connectBtn.textContent = 'Connect Outlook';
    refreshBtn.disabled = true;
    $('#style-summary').textContent = '';
  }
  $('#draft-course').innerHTML = state.data.courses.length
    ? state.data.courses.map((c) => `<option value="${c.id}">${esc(c.name)}${c.code ? ' (' + esc(c.code) + ')' : ''}</option>`).join('')
    : '<option value="">Add a course first</option>';
}
$('#outlook-connect').addEventListener('click', async () => {
  const disconnecting = $('#outlook-connect').textContent.includes('Disconnect');
  if (!disconnecting) $('#outlook-status').textContent = 'Waiting for the sign-in window…';
  const result = disconnecting ? await api.outlookDisconnect() : await api.outlookConnect(false);
  if (result.error) {
    $('#outlook-status').textContent = result.error;
    if (result.needsAdminConsent) $('#outlook-note').textContent = 'Many universities block third-party mail access until IT approves the app. You can request approval from that screen, or connect a personal Microsoft account. Either way, the drafter below works right now and the Copy button puts the email on your clipboard.';
    return showToast(result.needsAdminConsent ? 'Your school needs to approve mail access.' : result.error);
  }
  showToast(result.connected ? 'Outlook connected (read-only).' : 'Outlook disconnected.');
  renderEmail();
});
$('#outlook-refresh-style').addEventListener('click', async () => {
  $('#draft-status').textContent = 'Reading your sent mail…';
  const result = await api.styleRefresh();
  $('#draft-status').textContent = '';
  if (result.error) return showToast(result.error);
  showToast(`Style profile updated from ${result.count || 0} sent emails.`);
  renderEmail();
});
$('#draft-generate').addEventListener('click', async () => {
  const courseId = $('#draft-course').value;
  const course = state.data.courses.find((c) => String(c.id) === String(courseId));
  const request = {
    course_name: course?.name || '',
    course_code: course?.code || '',
    professor_name: $('#draft-prof-name').value.trim(),
    professor_email: $('#draft-prof-email').value.trim(),
    preferred_address: $('#draft-pref-name').value.trim(),
    section: $('#draft-section').value.trim(),
    help_type: $('#draft-help-type').value,
    student_name: $('#draft-student-name').value.trim(),
    excuse: $('#draft-excuse').value.trim(),
    notes: $('#draft-notes').value.trim(),
  };
  if (!request.professor_email) return showToast('Add the professor email.');
  $('#draft-status').textContent = 'Drafting…';
  const result = await api.draftProfessorEmail(request);
  $('#draft-status').textContent = '';
  if (result.error) return showToast(result.error);
  $('#draft-body').value = result.draft;
  $('#draft-output').classList.remove('hidden');
});
$('#draft-copy').addEventListener('click', () => {
  navigator.clipboard.writeText($('#draft-body').value);
  showToast('Draft copied.');
});
// ---- Your sending addresses (Gmail needs no OAuth; the account picker is
// what keeps two university addresses from being confused for each other) ----
function emailAccounts(){const v=state.data.preferences?.email_accounts;return Array.isArray(v)?v:[];}
function defaultAccount(){const list=emailAccounts();const d=state.data.preferences?.email_default;return list.includes(d)?d:(list[0]||'');}
function renderEmailAccounts(){
  const list=$('#email-account-list'); if(!list)return;
  const accounts=emailAccounts(), def=defaultAccount();
  list.innerHTML=accounts.length?accounts.map((a)=>`<div class="email-account${a===def?' default':''}"><span>${esc(a)}</span><div>${a===def?'<em>Default</em>':`<button class="text-button" data-account-default="${esc(a)}">Make default</button>`}<button class="row-delete" data-account-remove="${esc(a)}" title="Remove">×</button></div></div>`).join(''):'<div class="empty-state">No addresses yet. Add the one you email professors from.</div>';
  renderDraftFrom();
}
function renderDraftFrom(){
  const sel=$('#draft-from'); if(!sel)return;
  const accounts=emailAccounts(), def=defaultAccount();
  const wrap=sel.closest('.draft-from');
  if(wrap) wrap.classList.toggle('hidden',accounts.length<2);
  sel.innerHTML=accounts.length?accounts.map((a)=>`<option value="${esc(a)}"${a===def?' selected':''}>${esc(a)}</option>`).join(''):'<option value="">No address saved</option>';
}
async function saveAccounts(list,def){
  await api.setPreference('email_accounts',list);
  if(def!==undefined) await api.setPreference('email_default',def);
  state.data=await api.getState();
  renderEmailAccounts();
}
$('#email-account-save')?.addEventListener('click',async()=>{
  const input=$('#email-account-input'); const value=(input.value||'').trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))return showToast('That does not look like an email address.');
  const list=emailAccounts();
  if(list.includes(value))return showToast('That address is already saved.');
  input.value='';
  await saveAccounts([...list,value],list.length?undefined:value);
  showToast('Address saved.');
});
$('#email-account-input')?.addEventListener('keydown',(e)=>{if(e.key==='Enter')$('#email-account-save').click();});
$('#email-account-list')?.addEventListener('click',async(e)=>{
  const b=e.target.closest('button'); if(!b)return;
  if(b.dataset.accountDefault){await saveAccounts(emailAccounts(),b.dataset.accountDefault);showToast('Default address updated.');return;}
  if(b.dataset.accountRemove){
    const next=emailAccounts().filter((a)=>a!==b.dataset.accountRemove);
    await saveAccounts(next,next.includes(defaultAccount())?undefined:(next[0]||''));
    showToast('Address removed.');
  }
});

$('#draft-gmail').addEventListener('click', async () => {
  const raw = $('#draft-body').value;
  const to = $('#draft-prof-email').value.trim();
  if (!to) return showToast('Add the professor email first.');
  const from = $('#draft-from')?.value || defaultAccount();
  const subjectLine = raw.split('\n').find((l) => l.toLowerCase().startsWith('subject:'));
  const subject = subjectLine ? subjectLine.replace(/^subject:\s*/i, '').trim() : 'Email from your student';
  const body = raw.split('\n').filter((l) => !l.toLowerCase().startsWith('subject:')).join('\n').trim();
  const result = await api.gmailCompose({ to, subject, body, from });
  if (result?.error) return showToast(result.error);
  showToast(from ? `Draft opened in Gmail as ${from}. Review and send there.` : 'Draft opened in Gmail. Review and send from there.');
});
$('#draft-send').addEventListener('click', async () => {
  const body = $('#draft-body').value;
  const professorEmail = $('#draft-prof-email').value.trim();
  const subject = body.split('\n').find((l) => l.toLowerCase().startsWith('subject:'));
  const subjectText = subject ? subject.replace(/^subject:\s*/i, '') : 'Email from your student';
  if (!professorEmail) return showToast('Add the professor email before sending.');
  if (!confirm('Send this email to ' + professorEmail + ' via your Outlook? You are approving this send.')) return;
  const result = await api.outlookSend({ to: professorEmail, subject: subjectText, body });
  if (result.needsSendScope) {
    if (confirm('This Outlook connection is read-only. Reconnect and also ask for permission to send?')) {
      const reconnect = await api.outlookConnect(true);
      if (reconnect.error) return showToast(reconnect.error);
      showToast('Reconnected with sending. Press send again.');
      renderEmail();
    }
    return;
  }
  if (result.error) return showToast(result.error);
  showToast('Email sent via Outlook. Check your Sent folder.');
  $('#draft-output').classList.add('hidden');
});

const askInput=$('#ask-input'),askAnswer=$('#ask-answer');
api.onDesktopTour?.(()=>{beginCoach();});
$('#hero-nodes').addEventListener('click',(event)=>{const node=event.target.closest('[data-go]');if(node)setView(node.dataset.go);});
document.addEventListener('keydown',(event)=>{
  if(event.key==='/'&&state.view==='today'&&!/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName||'')){event.preventDefault();askInput.focus();}
});
// The topbar ask works from every view. Questions answer in a floating card
// right here; write-proposals jump to Today where the confirm card lives.
const globalAnswer=$('#global-answer');
async function submitGlobalAsk(){
  const input=$('#global-ask');
  const text=input.value.trim(); if(!text)return;
  input.value='';
  if(guideAnswer(text,globalAnswer))return;
  state.busy=true;renderHero();
  try{
    const result=await api.assistantParse(text);
    if(result.error||!result.proposal||!result.proposal.needs_confirm){await answerWithAi(result?.proposal?.command?.question||text,globalAnswer,Boolean(result.error));return;}
    state.proposal=result.proposal;setView('today');renderProposal();
  }finally{state.busy=false;renderHero();}
}
$('#global-ask-go').addEventListener('click',submitGlobalAsk);
$('#global-ask').addEventListener('keydown',(event)=>{if(event.key==='Enter')submitGlobalAsk();if(event.key==='Escape')globalAnswer.classList.add('hidden');});
document.addEventListener('click',(event)=>{if(!globalAnswer.classList.contains('hidden')&&!event.target.closest('#global-answer,.topbar-ask'))globalAnswer.classList.add('hidden');});

// Email: let Nūs fill the form from what it already knows.
$('#draft-fill')?.addEventListener('click',()=>{
  const courseId=Number($('#draft-course').value)||state.data.courses[0]?.id;
  const course=state.data.courses.find((c)=>c.id===courseId);
  if(!course){showToast('Add a course first, then Nūs can fill this.');return;}
  if(course.code&&!$('#draft-section').value)$('#draft-section').value=course.code;
  const syllabus=state.data.sources.find((src)=>src.source_type==='syllabus'&&src.course_id===courseId);
  const text=syllabus?.raw_text||'';
  if(!$('#draft-prof-name').value){const m=text.match(/(?:professor|instructor|prof\.?|dr\.?)[:\s]+([A-Z][a-zA-Z.'-]+(?:\s+[A-Z][a-zA-Z.'-]+){0,2})/i);if(m)$('#draft-prof-name').value=m[1].trim();}
  if(!$('#draft-prof-email').value){const m=text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(?:edu|org|com)/);if(m)$('#draft-prof-email').value=m[0];}
  if(!$('#draft-pref-name').value&&$('#draft-prof-name').value)$('#draft-pref-name').value='Professor '+$('#draft-prof-name').value.split(' ').slice(-1)[0];
  if(!$('#draft-student-name').value&&state.data.preferences.student_name)$('#draft-student-name').value=state.data.preferences.student_name;
  const filled=['#draft-section','#draft-prof-name','#draft-prof-email','#draft-pref-name'].filter((sel)=>$(sel).value).length;
  showToast(filled?`Filled ${filled} field${filled===1?'':'s'} from your syllabus and settings. Check them before drafting.`:'Nothing in the syllabus to pull from yet. Import one and try again.');
});

const APP_GUIDE=[
  {match:/syllab|import.*(course|class|pdf)|upload.*(syllab|pdf)/,go:'semester',label:'Open Semester',answer:'Import a syllabus from the Import button up top or the Semester view. Nūs reads it with your AI, then shows every extracted course, weight, and deadline in a review table. Nothing is saved until you confirm it.'},
  {match:/where.*(map|graph|brain)|mind ?map|constellation/,go:'brain',label:'Open the Map',answer:'The Map is item 02 in the rail. Every course, source, and open task is a node you can drag; scroll to zoom around your cursor, drag the canvas to pan, and Center map reframes everything.'},
  {match:/turn off|remove|disable|get rid.*(companion|knot|overlay)|companion.*(off|remove)/,go:'companion',label:'Open Knot settings',answer:'Turn off Companion, on the Knot > Companion pane, removes it completely: capture stops, the overlay closes, and the hotkeys go back to your system. It stays off across restarts until you press Turn on Companion in the same place.'},
  {match:/close|quit|exit|background|still running|stays open/,go:'companion',label:'Open Knot settings',answer:'Closing the dashboard leaves the Companion running on your desktop with every hotkey live, the same way it works after a restart. The tray icon reopens the dashboard or quits Nūs entirely, and Turn off Companion on this pane removes the overlay for good.'},
  {match:/stealth|invisible|hide.*(companion|overlay|knot)/,go:'companion',label:'Open Knot settings',answer:'Ctrl+Shift+Space hides the whole Companion, Ctrl+Shift+K hides just the Knot mark, Ctrl+Shift+X stops listening and vanishes. Stealth mode (off by default) also hides the tray icon; this pane is always the way back.'},
  {match:/history|transcript|recording|session/,go:'history',label:'Open History',answer:'Every Companion capture session lands under Knot > History: full transcript, search, and upload into your Jarvis vault with a preview before anything is written.'},
  {match:/gemini|companion.*(key|api)|key.*companion|overlay.*key/,go:'settings',label:'Open Settings',answer:'The Companion needs its own key, separate from the desktop app\'s Claude. In Settings, the "Companion AI key" card sits right under AI provider: paste a Google Gemini key there (free tier at aistudio.google.com/apikey) and the Knot starts answering. One Gemini key covers both its answers and speech-to-text for listening. The Knot\'s gear icon sets the same key.'},
  {match:/api key|anthropic|claude key|which model/,go:'settings',label:'Open Settings',answer:'Two keys, two jobs. Desktop app: Claude, found automatically if Claude Code is installed, otherwise an Anthropic API key in Settings > AI provider. It runs on Sonnet so syllabus reading stays affordable. Companion overlay: its own Gemini key in the Companion AI key card just below.'},
  {match:/gmail/,go:'email',label:'Open Email',answer:'Gmail needs no connection: draft the email in the Email tab, then press Open in Gmail. The finished draft opens in a Gmail compose window in your browser with everything filled in, and you press send there.'},
  {match:/email|professor|outlook/,go:'email',label:'Open Email',answer:'Email has its own tab in the rail. Connect Outlook read-only for the inbox brief and your writing style; the professor drafter works even without connecting, and any draft can open straight into Gmail with the Open in Gmail button.'},
  {match:/dashboard|home page|main page|back to today/,go:'today',label:'Open Today',answer:'The dashboard is the Today tab, item 01 in the rail. If the app window is closed, the tray icon has Open Nūs dashboard.'},
  {match:/chat|talk to n|ask.*question/,go:'companion',label:'Open the chat',answer:'Chat with Nūs lives under Knot in the rail, on the Companion pane: a running thread that answers questions and can set up tasks, dates, and email drafts with a confirm step. The Ask bar on Today does one-shot requests from anywhere.'},
  {match:/automat|rule|repeat/,go:'automations',label:'Open Automations',answer:'Automations live under Connections. Nūs proposes a rule after it sees the same kind of task twice; every rule needs your approval before it ever runs.'},
  {match:/calendar|gcal|google/,go:'calendar',label:'Open Calendar',answer:'Calendar shows confirmed deadlines, smart tasks, and Google Calendar events in one month. The mini calendar on the dashboard jumps to any day.'},
  {match:/tutorial|walkthrough|tour|how.*(use|work)/,go:'settings',label:'Open Settings',answer:'Replay the walkthrough any time from Settings, and the Knot tutorial from the Knot > Companion pane. The two tours link to each other.'},
  {match:/gpa|grade/,go:'semester',label:'Open Semester',answer:'GPA projection lives on the dashboard pulse and in Semester. It splits what is known from what is assumed, and never guesses missing weights: verify your GPA scale once in Settings.'},
  {match:/knot|companion|overlay|assistant/,go:'companion',label:'Open the Knot pane',answer:'The Knot is the on-screen Companion: it sees the screen you choose, listens when you switch it on, and answers from your briefing packs. Manage it under Knot in the rail.'},
];
function guideAnswer(query,target){
  const q=String(query||'').toLowerCase();
  const hit=APP_GUIDE.find((entry)=>entry.match.test(q));
  if(!hit)return false;
  target.innerHTML=`${esc(hit.answer)} <button type="button" class="text-button" data-guide-go="${hit.go}">${esc(hit.label)} →</button>`;
  target.classList.remove('hidden');
  target.querySelector('[data-guide-go]').addEventListener('click',()=>{setView(hit.go);target.classList.add('hidden');});
  return true;
}
// Questions get a real AI answer over the chat pipeline (qaOnly skips a second
// intent parse since the caller already ran one). Local answers remain the
// offline fallback.
async function answerWithAi(query,target,skipAi){
  target=target||askAnswer;
  if(guideAnswer(query,target))return;
  if(skipAi){answerLocally(query,target);return;}
  target.textContent='Nūs is thinking…';target.classList.remove('hidden');
  const result=await api.chatSend([{role:'user',text:query}],{qaOnly:true}).catch(()=>null);
  if(!result||result.error||!result.text){answerLocally(query,target);return;}
  target.textContent=result.text;
}
function answerLocally(query,target){
  target=target||askAnswer;
  if(guideAnswer(query,target))return;
  const q=String(query||'').toLowerCase(),next=state.data.ranked[0];
  if(/gpa|grade/.test(q))target.textContent=state.data.gpa.overall==null?'Add grading weights first. Nūs will not guess your GPA.':`Your current projection is ${state.data.gpa.overall.toFixed(2)}.`;
  else if(/calendar|when|due|today/.test(q)){
    const rk=state.data.ranked||[],dd=(r)=>dayDistance(r.due_date);
    const today=rk.filter((r)=>dd(r)===0),overdue=rk.filter((r)=>dd(r)!==null&&dd(r)<0),upcoming=rk.filter((r)=>dd(r)!==null&&dd(r)>0);
    if(/today/.test(q)){
      target.textContent=today.length
        ?`Due today: ${today.map((r)=>r.title).join(', ')}.`
        :`Nothing is actually due today.${overdue.length?` ${overdue.length} overdue item${overdue.length===1?' still needs':'s still need'} attention, starting with ${overdue[0].title}.`:''}${upcoming.length?` Next up: ${upcoming[0].title}, ${relativeDue(upcoming[0].due_date).toLowerCase()}.`:''}`;
    }else{
      const first=upcoming[0]||today[0]||rk[0];
      target.textContent=first?`${first.title} is ${relativeDue(first.due_date).toLowerCase()}. Open Calendar for the full month.`:'There are no confirmed deadlines yet.';
    }
  }
  else if(/automate|repeat/.test(q))target.textContent=state.data.repeated_signals.length?`I found ${state.data.repeated_signals.length} repeated pattern. Open Automations to approve it.`:'I need to see a similar task twice before I suggest a rule.';
  else target.textContent=next?`Start with ${next.title}. ${next.reason}`:'Import one real syllabus or add one smart task and I can give you a grounded next move.';
  target.classList.remove('hidden');
}

// The constellation: your semester as labeled stars around the living Knot.
// Star field is generated once; nodes and edges re-render from live data.
let heroKnot3d=null;
let heroStarsSeeded=false;
function seedHeroStars(){
  if(heroStarsSeeded)return;
  heroStarsSeeded=true;
  const wrap=$('#hero-stars'); if(!wrap)return;
  let html='';
  for(let i=0;i<42;i++){
    const x=(i*61.7)%100, y=((i*37.3)+13)%100;             // deterministic scatter
    const size=i%9===0?2.2:1.2;
    const twinkle=i%7===0?` class="twinkle" style="animation-delay:${(i%5)*.9}s;`:' style="';
    html+=`<i${twinkle}left:${x}%;top:${y}%;width:${size}px;height:${size}px"></i>`;
  }
  wrap.innerHTML=html;
}
function constellationItems(){
  const risky=(due)=>{const d=dayDistance(due);return d!==null&&d<=2;};
  const courses=state.data.courses.slice(0,3).map((course)=>{const[,tone]=courseStatus(course);return{kind:'course',label:course.code||course.name,attention:tone==='risk',go:'semester'};});
  const sources=state.data.sources.slice(0,2).map((source)=>({kind:'source',label:source.title||'Source',attention:false,go:'sources'}));
  const tasks=state.data.tasks.filter((task)=>!task.done).slice(0,2).map((task)=>({kind:'task',label:task.title,attention:risky(task.due_date),go:'tasks'}));
  const items=[...courses,...sources,...tasks].slice(0,7);
  if(!items.length)items.push({kind:'source',label:'Import a syllabus',attention:false,go:'semester'});
  return items;
}
let lastConstellationKey='';
function renderConstellation(){
  const field=$('#hero-field'); if(!field)return;
  seedHeroStars();
  if(!heroKnot3d&&window.NusKnot3D){heroKnot3d=NusKnot3D.mount($('#hero-knot'));}
  const items=constellationItems();
  const rect=field.getBoundingClientRect();
  const wPx=Math.max(1,rect.width), hPx=Math.max(1,rect.height);
  // Rebuilding the DOM restarts every node's drift animation, so skip when
  // neither the items nor the field size changed (companion state events
  // arrive constantly and must not make the labels jump).
  const key=JSON.stringify(items)+'|'+Math.round(wPx)+'x'+Math.round(hPx);
  // Skip only when the content is unchanged AND what is on screen still matches
  // it. Trusting the key alone left the constellation blank for good if anything
  // cleared the nodes, since the key still said "already painted".
  const painted=$('#hero-nodes').children.length;
  if(key===lastConstellationKey&&painted===items.length)return;
  lastConstellationKey=key;
  // Slot geometry is measured, not guessed. The clearance ring uses the radius
  // the knot is actually DRAWN at (0.33 of the canvas min side, plus tube and
  // glow headroom = 0.41), not the canvas box, which is 40px oversized.
  const knotEl=$('#hero-knot');
  const kr=knotEl?knotEl.getBoundingClientRect():{width:150,height:150};
  const knotR=Math.min(kr.width||150,kr.height||150)*0.41;
  const NODE_H=16, NODE_HALF_W=78, PAD=14;
  const cx=50,cy=46;
  // Keep nodes outside the Knot first, inside the field when possible. When
  // the field is too small for both, clearing the Knot wins and labels may
  // clip the edge instead of sitting on the mark.
  const minRy=knotR+NODE_H+PAD, maxRy=hPx*cy/100-NODE_H-2;
  const minRx=knotR+NODE_HALF_W+PAD, maxRx=wPx/2-NODE_HALF_W-6;
  const ryPx=Math.max(minRy, Math.min(maxRy, hPx*0.40));
  const rxPx=Math.max(minRx, Math.min(maxRx, wPx*0.40));
  const count=Math.max(items.length,1);
  const slots=items.map((_,index)=>{
    const angle=-Math.PI/2+0.42+(index/count)*Math.PI*2;
    return[wPx*cx/100+Math.cos(angle)*rxPx, hPx*cy/100+Math.sin(angle)*ryPx];
  });
  // One greedy pass over angular neighbours (including the wrap pair): push
  // the later node radially outward until the pair no longer overlaps.
  for(let i=0;i<slots.length&&slots.length>1;i++){
    const a=slots[i], b=slots[(i+1)%slots.length];
    const dx=Math.abs(a[0]-b[0]), dy=Math.abs(a[1]-b[1]);
    if(dx<NODE_HALF_W*2&&dy<NODE_H+6){
      const j=(i+1)%slots.length;
      const ox=slots[j][0]-wPx*cx/100, oy=slots[j][1]-hPx*cy/100;
      const len=Math.max(1,Math.hypot(ox,oy));
      const push=Math.min(NODE_HALF_W*2-dx,NODE_H+6-dy)+4;
      slots[j][0]=Math.min(wPx-NODE_HALF_W,Math.max(NODE_HALF_W,slots[j][0]+ox/len*push));
      slots[j][1]=Math.min(hPx-NODE_H,Math.max(NODE_H,slots[j][1]+oy/len*push));
    }
  }
  const pct=slots.map(([x,y])=>[(x/wPx)*100,(y/hPx)*100]);
  $('#hero-edges').innerHTML=items.map((_,index)=>{
    const[x,y]=pct[index];const bend=index%2?6:-6;
    return`<path d="M ${cx} ${cy} Q ${(cx+x)/2+bend} ${(cy+y)/2-bend} ${x} ${y}" vector-effect="non-scaling-stroke"/>`;
  }).join('');
  $('#hero-edges').setAttribute('viewBox','0 0 100 100');
  $('#hero-edges').setAttribute('preserveAspectRatio','none');
  $('#hero-nodes').innerHTML=items.map((item,index)=>{
    const[x,y]=pct[index];
    const short=String(item.label).replace(/\.[a-z0-9]+$/i,'').slice(0,17);
    return`<button type="button" class="hero-node ${item.kind}${item.attention?' attention':''}" data-go="${item.go}" style="left:${x}%;top:${y}%;--node-delay:${index*.4}s"><i></i><span>${esc(short)}</span></button>`;
  }).join('');
}
// Re-lay-out on real size changes (the render key ignores stale layouts).
if(window.ResizeObserver){
  const heroField=$('#hero-field');
  if(heroField)new ResizeObserver(()=>renderConstellation()).observe(heroField);
}

function renderHero(){
  // The agent chips now read the real Companion, not a hardcoded false. Knot
  // state: thinking (desktop busy) > listening (capturing) > ready (on screen)
  // > idle. The Today hero and the overlay Knot show the same truth.
  const cs=companionState;
  const knotState = (state.busy || cs.busy) ? 'thinking' : cs.capturing ? 'listening' : cs.visible ? 'ready' : 'idle';
  const chips=[['Idle',knotState==='idle'],['Listening',knotState==='listening'],['Thinking',knotState==='thinking'],['Ready',knotState==='ready']];
  $('#hero-chips').innerHTML=chips.map(([label,on])=>`<span class="hero-chip${on?` on state-${knotState}`:''}">${label}</span>`).join('');
  const orb=$('#hero-orb'); orb.dataset.knot=knotState; orb.classList.toggle('working',Boolean(state.busy));
  renderConstellation();
  if(heroKnot3d)heroKnot3d.setState(knotState);
  const bubbles=[];
  const syllabusCourses=state.data.sources.filter((s)=>s.source_type==='syllabus'&&s.course_id).map((s)=>state.data.courses.find((c)=>c.id===s.course_id)?.name).filter(Boolean);
  if(syllabusCourses.length)bubbles.push(`${syllabusCourses[0]} syllabus`);
  if((state.data.gcal_events||[]).length||state.data.integrations.some((i)=>i.provider==='calendar_file'&&i.status==='connected'))bubbles.push('Calendar synced');
  if(state.outlook?.connected)bubbles.push('Outlook connected');
  if(state.style?.ready)bubbles.push('Writing style learned');
  const openTasks=state.data.tasks.filter((t)=>!t.done).length;
  if(bubbles.length<4&&state.data.courses.length)bubbles.push(`${state.data.courses.length} course${state.data.courses.length===1?'':'s'} tracked`);
  if(bubbles.length<4&&openTasks)bubbles.push(`${openTasks} open task${openTasks===1?'':'s'}`);
  $('#hero-bubbles').innerHTML=bubbles.slice(0,4).map((b)=>`<span>${esc(b)}</span>`).join('');
}

function relativeTime(iso){if(!iso)return'';const mins=Math.round((Date.now()-new Date(iso+(iso.endsWith('Z')||iso.includes('+')?'':'Z')))/60000);if(mins<1)return'now';if(mins<60)return`${mins}m ago`;if(mins<1440)return`${Math.round(mins/60)}h ago`;return`${Math.round(mins/1440)}d ago`;}

function renderActivity(){
  const feed=state.data.activity||[];
  const glyphs={done:'✓',review:'✦',waiting:'○'};
  $('#activity-feed').innerHTML=feed.length?feed.slice(0,6).map((row)=>`<div class="feed-row"><span class="feed-glyph ${esc(row.status)}">${glyphs[row.status]||'✓'}</span><div><strong>${esc(row.summary)}</strong>${row.detail?`<small>${esc(row.detail)}</small>`:''}</div><span class="feed-time">${relativeTime(row.created_at)}</span></div>`).join(''):'<div class="empty-state">Nūs has not acted yet. Ask it to handle something above.</div>';
}

// ---- Companion control panel (Jarvis rail) ----
let companionState = { running: false, visible: false, capturing: false, stealth: false };

function renderCompanionPanel(){
  api.companionStatus?.().then((s)=>{ if(s) companionState=s; paintCompanionPanel(); }).catch(()=>paintCompanionPanel());
  paintCompanionPanel();
}
function paintCompanionPanel(){
  const badge=$('#companion-state-badge'); const title=$('#companion-state-title');
  if(!badge) return;
  const s=companionState;
  const off = s.enabled===false;
  const label = off ? 'Turned off' : !s.running ? 'Off' : s.capturing ? 'Listening' : s.visible ? 'On screen' : (s.stealth?'Stealth':'Hidden');
  badge.textContent=label;
  badge.className='status-badge'+(off?'':(s.capturing?' live':(s.visible?' good':'')));
  title.textContent = off ? 'Companion is turned off' : s.capturing ? 'Companion is listening' : s.visible ? 'Companion is on screen' : 'Companion';
  const power=$('#companion-power'); if(power) power.textContent = off ? 'Turn on Companion' : 'Turn off Companion';
  // With the Companion off there is nothing to show, hide, listen with, or tour.
  ['#companion-show','#companion-hide','#companion-knot','#companion-capture','#companion-tutorial'].forEach((sel)=>{
    const b=$(sel); if(b) b.disabled=off;
  });
  const cap=$('#companion-capture'); if(cap) cap.textContent = s.capturing ? 'Stop listening' : 'Start listening';
  const knot=$('#companion-knot'); if(knot) knot.textContent = s.knotHidden ? 'Show Knot mark' : 'Hide Knot mark';
}
function bindCompanion(action){ return async()=>{ const s=await api.companionControl?.(action); if(s) companionState=s; paintCompanionPanel(); }; }
$('#companion-show')?.addEventListener('click', bindCompanion('show'));
$('#companion-hide')?.addEventListener('click', bindCompanion('hide'));
$('#companion-tutorial')?.addEventListener('click',async()=>{await api.companionControl?.('tour');});
$('#companion-knot')?.addEventListener('click', bindCompanion('knot'));
$('#companion-power')?.addEventListener('click', async()=>{
  const off=companionState.enabled===false;
  // Killing a live capture mid-meeting deserves one question. Turning it back
  // on, or off while idle, is a single click.
  if(!off&&companionState.capturing&&!confirm('The Companion is listening right now. Turn it off and end this capture session?'))return;
  const s=await api.companionControl?.(off?'enable':'disable');
  if(s) companionState=s;
  paintCompanionPanel(); renderHero();
  showToast(off?'Companion is back on your desktop.':'Companion removed. Hotkeys released. Turn it back on here any time.');
});
$('#companion-capture')?.addEventListener('click', async()=>{ const s=await api.companionControl?.(companionState.capturing?'capture-stop':'capture-start'); if(s) companionState=s; paintCompanionPanel(); });
api.onCompanionState?.((s)=>{ if(s){ companionState=s; if(state.view==='companion') paintCompanionPanel(); renderHero(); } });

// ---- Knot-pane chat: a persistent thread over the same AI pipeline. ----
// Actionable requests come back with a proposal; the confirm buttons run the
// same assistantExecute as the Ask bar, so chat never writes silently.
try{state.chat=JSON.parse(localStorage.getItem('nus-chat')||'[]').slice(-50);}catch{state.chat=[];}
let chatPending=false, chatProposal=null;
function persistChat(){localStorage.setItem('nus-chat',JSON.stringify(state.chat.slice(-50).map(({role,text})=>({role,text}))));}
function renderChat(){
  const thread=$('#chat-thread'); if(!thread) return;
  const actions=chatProposal?'<div class="chat-actions"><button id="chat-confirm" class="primary-button" type="button">Confirm</button><button id="chat-cancel" class="quiet-button" type="button">Not now</button></div>':'';
  thread.innerHTML=state.chat.length
    ?state.chat.map((m)=>`<div class="chat-bubble ${m.role==='nus'?'nus':'you'}">${esc(m.text)}</div>`).join('')+actions+(chatPending?'<div class="chat-bubble nus pending">Nūs is thinking…</div>':'')
    :'<div class="empty-state">Ask about deadlines, or tell Nūs to add a task, move a date, or draft an email. It talks it through and confirms before it touches anything.</div>';
  thread.scrollTop=thread.scrollHeight;
}
async function sendChat(){
  const input=$('#chat-input'); const text=(input?.value||'').trim();
  if(!text||chatPending) return;
  input.value='';
  chatProposal=null; // a new message supersedes any unconfirmed proposal
  state.chat.push({role:'user',text});
  state.chat=state.chat.slice(-50);
  chatPending=true; $('#chat-send')?.setAttribute('disabled','');
  renderChat();
  try{
    const result=await api.chatSend(state.chat.slice(-12));
    if(result?.error){showToast(aiError(result.error,result.detail));state.chat.pop();}
    else{
      state.chat.push({role:'nus',text:result.text||'…'});
      chatProposal=result.proposal||null;
    }
    persistChat();
  }finally{
    chatPending=false; $('#chat-send')?.removeAttribute('disabled');
    renderChat();
  }
}
$('#chat-send')?.addEventListener('click',sendChat);
$('#chat-input')?.addEventListener('keydown',(e)=>{if(e.key==='Enter')sendChat();});
$('#chat-thread')?.addEventListener('click',async(e)=>{
  const b=e.target.closest('button'); if(!b)return;
  if(b.id==='chat-cancel'){chatProposal=null;state.chat.push({role:'nus',text:'Okay, holding off. Anything else?'});persistChat();renderChat();return;}
  if(b.id!=='chat-confirm'||!chatProposal)return;
  const proposal=chatProposal;chatProposal=null;renderChat();
  const result=await api.assistantExecute(proposal);
  if(result?.error){state.chat.push({role:'nus',text:aiError(result.error,result.detail)});}
  else{
    state.chat.push({role:'nus',text:result.message||'Done.'});
    if(result.navigate==='email'){
      if(result.prefill?.help_type)$('#draft-help-type').value=result.prefill.help_type;
      if(result.prefill?.course_id)$('#draft-course').value=String(result.prefill.course_id);
      setView('email');autoDraftEmail();
    }else await load();
  }
  persistChat();renderChat();
});
api.onCompanionMessage?.((m)=>{ if(state.view==='history' && state.historySession===m.sessionId) renderHistoryDetail(state.historySession); });

// ---- Companion session history ----
async function renderHistory(){
  const q=($('#history-search')?.value||'').trim();
  const list=$('#history-sessions'); if(!list) return;
  let sessions=await api.companionSessions?.()||[];
  if(q){
    const hits=await api.companionSearch?.(q)||[];
    const ids=new Set(hits.map((h)=>h.session_id));
    sessions=sessions.filter((s)=>ids.has(s.id));
  }
  list.innerHTML=sessions.length?sessions.map((s)=>{
    const day=new Date(s.started_at).toLocaleDateString(undefined,{month:'short',day:'numeric'});
    const t=new Date(s.started_at).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
    const name=esc(s.title||s.first_line||'Session');
    return `<button class="history-session${state.historySession===s.id?' active':''}" data-session="${s.id}"><strong>${name.slice(0,60)}</strong><small>${day} · ${t} · ${s.message_count||0} lines${s.pack?' · pack':''}</small></button>`;
  }).join(''):'<div class="history-empty">No sessions yet. Start the Companion listening during a meeting.</div>';
}
$('#history-sessions')?.addEventListener('click',(e)=>{const b=e.target.closest('[data-session]');if(b){state.historySession=Number(b.dataset.session);renderHistory();renderHistoryDetail(state.historySession);}});
let historySearchTimer=null;
$('#history-search')?.addEventListener('input',()=>{clearTimeout(historySearchTimer);historySearchTimer=setTimeout(renderHistory,220);});

async function renderHistoryDetail(sessionId){
  const el=$('#history-detail'); if(!el) return;
  const messages=await api.companionMessages?.(sessionId)||[];
  const sessions=await api.companionSessions?.()||[];
  const s=sessions.find((x)=>x.id===sessionId)||{};
  const roleName={you:'Me',them:'Them',nus:'Nūs'};
  const rows=messages.map((m)=>{
    const t=(m.ts||'').slice(11,16);
    return `<div class="hist-line ${esc(m.channel)}"><span class="hist-who">${roleName[m.channel]||m.channel}</span><span class="hist-time">${t}</span><p>${esc(m.text)}</p></div>`;
  }).join('');
  const audio = s.audio_path ? `<span class="hist-audio">Audio retained</span>` : '';
  el.innerHTML=`<div class="hist-head"><div><h2>${esc(s.title||'Session')}</h2><small>${s.started_at?new Date(s.started_at).toLocaleString():''}${s.pack?' · briefing pack loaded':''} ${audio}</small></div>`+
    `<button id="hist-upload" class="primary-button" type="button" data-session="${sessionId}">Upload to Jarvis vault</button></div>`+
    `<div class="hist-transcript">${rows||'<div class="history-empty">This session has no transcript lines.</div>'}</div>`;
}
// Vault upload is a two-step, preview-then-write flow: it shows the exact
// markdown Nūs will create before anything touches the vault, honoring the
// no-silent-side-effects rule.
$('#history-detail')?.addEventListener('click',async(e)=>{
  const up=e.target.closest('#hist-upload'); if(!up) return;
  const sessionId=Number(up.dataset.session);
  const preview=await api.companionVaultPreview?.(sessionId);
  if(!preview||preview.error){showToast(preview?.error==='session_empty'?'Nothing to upload yet.':'Could not build the note.');return;}
  showVaultPreview(sessionId, preview);
});
function showVaultPreview(sessionId, preview){
  const scrim=$('#vault-scrim');
  $('#vault-filename').textContent=preview.fileName;
  $('#vault-dir').textContent=preview.dir;
  $('#vault-body').textContent=preview.content;
  $('#vault-warn').textContent=preview.vaultOk?'':'Vault not found on this machine. Set JARVIS_VAULT to point at it.';
  scrim.classList.remove('hidden');
  $('#vault-confirm').onclick=async()=>{
    const res=await api.companionVaultWrite?.(sessionId);
    scrim.classList.add('hidden');
    showToast(res?.ok?('Saved to vault: '+res.path.split(/[\\/]/).pop()):(res?.error||'Write failed.'));
  };
}
$('#vault-cancel')?.addEventListener('click',()=>$('#vault-scrim').classList.add('hidden'));

function renderInbox(){
  const box=$('#inbox-brief'); if(!box)return;
  if(!state.outlook?.connected){box.innerHTML='<div class="empty-state">Connect email in Settings to see what needs a reply. <button class="text-button" data-goto-email>Open email settings</button></div>';return;}
  if(state.inbox?.error){box.innerHTML='<div class="empty-state">Could not reach your inbox just now.</div>';return;}
  const messages=state.inbox?.messages||[];
  box.innerHTML=messages.length?messages.map((m)=>`<div class="inbox-row${m.unread?' unread':''}"><div><strong>${esc(m.from_name)}</strong><small>${esc(m.subject)} · ${esc(m.preview)}</small></div><span class="feed-time">${relativeTime(m.received_at)}</span></div>`).join(''):'<div class="empty-state">Inbox is quiet.</div>';
}

async function submitToNus(text){
  state.busy=true;renderHero();
  try{
    const result=await api.assistantParse(text);
    if(result.error==='no_ai'||result.error==='cli_not_logged_in'){answerLocally(text);showToast(aiError(result.error));return;}
    if(result.error){showToast(aiError(result.error,result.detail));return;}
    const proposal=result.proposal;
    if(!proposal.needs_confirm){await answerWithAi(proposal.command.question||text,askAnswer);return;}
    state.proposal=proposal;renderProposal();
  }finally{state.busy=false;renderHero();}
}

const HELP_TYPE_OPTIONS=[['extension','Extension'],['missing-attendance','Missed class'],['grade-question','Grade question'],['office-hours','Office hours'],['concept-help','Concept help'],['other','Something else']];
function renderProposal(){
  const p=state.proposal; const box=$('#nus-proposal');
  if(!p){box.classList.add('hidden');box.innerHTML='';return;}
  if(p.command.intent==='draft_email'){renderEmailWizard(box,p);return;}
  const target=p.resolved.target?`<small>Matched: "${esc(p.resolved.target.title)}"${p.resolved.target.course_name?` in ${esc(p.resolved.target.course_name)}`:''}</small>`:'';
  const notes=(p.notes||[]).map((n)=>`<small>${esc(n)}</small>`).join('');
  box.innerHTML=`<strong>Nūs wants to:</strong> ${esc(p.command.summary_for_user)}${target}${notes}<div class="proposal-actions"><button id="proposal-confirm" class="primary-button">Confirm</button><button id="proposal-cancel" class="quiet-button">Cancel</button></div>`;
  box.classList.remove('hidden');
}
// Email requests get a short guided conversation: pick the kind of help, pick
// the course, then Nūs opens the drafter, fills it from the syllabus, and
// writes the draft. Sending stays a human click.
function renderEmailWizard(box,p){
  const c=p.command;
  let body=`<strong>Nūs wants to:</strong> ${esc(c.summary_for_user)}`;
  if(!c.help_type){
    body+=`<small>What kind of help is this email asking for?</small><div class="proposal-actions wizard">${HELP_TYPE_OPTIONS.map(([v,l])=>`<button class="quiet-button" data-wiz-help="${v}">${l}</button>`).join('')}</div>`;
  }else if(!p.resolved.course_id&&!p.resolved.course_picked&&state.data.courses.length){
    body+=`<small>Which course is it for?</small><div class="proposal-actions wizard">${state.data.courses.slice(0,6).map((co)=>`<button class="quiet-button" data-wiz-course="${co.id}">${esc(co.code||co.name)}</button>`).join('')}<button class="quiet-button" data-wiz-course="none">No course</button></div>`;
  }else if(emailAccounts().length>1&&!p.resolved.from){
    body+=`<small>Which of your addresses should it come from?</small><div class="proposal-actions wizard">${emailAccounts().map((a)=>`<button class="quiet-button" data-wiz-from="${esc(a)}">${esc(a)}</button>`).join('')}</div>`;
  }else{
    const label=HELP_TYPE_OPTIONS.find(([v])=>v===c.help_type)?.[1]||'Email';
    const course=state.data.courses.find((co)=>co.id===p.resolved.course_id);
    const from=p.resolved.from||defaultAccount();
    body+=`<small>${esc(label)}${course?` for ${esc(course.code||course.name)}`:''}${from?`, from ${esc(from)}`:''}. I will open the drafter, fill what your syllabus knows, and write the draft. You review and press send (Outlook or Gmail).</small><div class="proposal-actions"><button id="proposal-confirm" class="primary-button">Draft it</button><button id="proposal-cancel" class="quiet-button">Cancel</button></div>`;
  }
  box.innerHTML=body; box.classList.remove('hidden');
}
// After the wizard lands on the Email view: fill from the syllabus, and if the
// professor's address was found, generate the draft immediately.
function autoDraftEmail(){
  $('#draft-fill')?.click();
  setTimeout(()=>{ if($('#draft-prof-email').value.trim())$('#draft-generate')?.click(); },400);
}
$('#nus-proposal').addEventListener('click',async(event)=>{
  const button=event.target.closest('button'); if(!button)return;
  if(button.dataset.wizHelp&&state.proposal){state.proposal.command.help_type=button.dataset.wizHelp;renderProposal();return;}
  if(button.dataset.wizCourse&&state.proposal){
    if(button.dataset.wizCourse!=='none')state.proposal.resolved.course_id=Number(button.dataset.wizCourse);
    state.proposal.resolved.course_picked=true;renderProposal();return;
  }
  if(button.dataset.wizFrom&&state.proposal){state.proposal.resolved.from=button.dataset.wizFrom;renderProposal();return;}
  if(button.id==='proposal-cancel'){state.proposal=null;renderProposal();return;}
  if(button.id!=='proposal-confirm'||!state.proposal)return;
  const proposal=state.proposal;state.proposal=null;renderProposal();
  const pickedFrom=proposal.resolved?.from;
  const result=await api.assistantExecute(proposal);
  if(result.error){showToast(aiError(result.error,result.detail));return;}
  if(result.navigate==='email'){
    if(result.prefill?.help_type)$('#draft-help-type').value=result.prefill.help_type;
    if(result.prefill?.course_id)$('#draft-course').value=String(result.prefill.course_id);
    setView('email');
    if(pickedFrom&&$('#draft-from'))$('#draft-from').value=pickedFrom;
    autoDraftEmail();
  }
  else await load();
  showToast(result.message||'Done.');
});
$('#inbox-brief').addEventListener('click',(event)=>{if(event.target.closest('[data-goto-email]'))setView('email');});
$('#today-list').addEventListener('click',async(event)=>{
  const button=event.target.closest('[data-move]'); if(!button)return;
  await api.updateAssignment(Number(button.dataset.move),{status:'done'});
  await load();showToast('Marked done.');
});
$('#view-history').addEventListener('click',()=>setView('history'));
$('#ask-go').addEventListener('click',()=>{const value=askInput.value.trim();if(!value)return;askInput.value='';submitToNus(value);});
askInput.addEventListener('keydown',(event)=>{
  if(event.key==='Escape'){askAnswer.classList.add('hidden');state.proposal=null;renderProposal();return;}
  if(event.key!=='Enter'||!askInput.value.trim())return;
  const value=askInput.value.trim();askInput.value='';submitToNus(value);
});

const focusOptions=[
  ['Heavy course load','Five or more classes, deadlines that overlap'],
  ['Research or a lab','Weekly meetings, reading, work with no due date'],
  ['A club or org you run','Events, budgets, people waiting on you'],
  ['Job or internship hunt','Applications and interviews on their own clock'],
  ['A side project','The thing you build when coursework lets you'],
  ['Grad school applications','Essays, recommenders, hard external dates'],
  ['Working while enrolled','Shifts that do not move for your exams'],
  ['Coming back after a break','Rebuilding a rhythm that lapsed'],
];
const focusPromise={
  'Heavy course load':'rank every class against the others so you are never guessing which deadline is the expensive one',
  'Research or a lab':'keep the long-running work visible next to the graded work that tries to bury it',
  'A club or org you run':'hold org dates in the same ledger as coursework, because they compete for the same nights',
  'Job or internship hunt':'treat application dates like graded ones, since missing those costs more',
  'A side project':'show you honestly how much room the semester actually leaves for it',
  'Grad school applications':'put the external dates on the same map as the ones your professors set',
  'Working while enrolled':'plan around the shifts you cannot move instead of pretending they are flexible',
  'Coming back after a break':'start small and show only what is confirmed, so week one is not a wall',
};
const tourSteps=[
  {view:'today',rail:'today',title:'This is your Jarvis',body:'The Ask bar takes plain requests like "push the calc homework to Friday" and proposes the exact change before anything is written. Below it: your three moves, what Nūs has done lately, and your inbox once email is connected.'},
  {view:'brain',rail:'brain',title:'The map is the whole point',body:'Every course, source, and open task as a node you can drag. Drag the canvas to pan, scroll to zoom around your cursor, and hit Center map to frame everything again. Your layout and viewport save locally.'},
  {view:'calendar',rail:'calendar',title:'Calendar is the month as it is',body:'Confirmed deadlines, your smart tasks, and anything you imported, in one grid. Click a day to pull its agenda up beside it.'},
  {view:'tasks',rail:'tasks',title:'Smart tasks turn pressure into steps',body:'Give Nūs an outcome and it proposes a small path you can edit. Nothing schedules itself and nothing runs without you checking it off.'},
  {view:'sources',rail:'semester',title:'Knowledge is what Nūs has read',body:'Under Semester, next to the overview. Courses, unfiled items, and raw imports each keep their own count, so you always know what Nūs read versus what you handed it.'},
  {view:'companion',rail:'companion',title:'The Knot rides on top of everything',body:'The Nūs Knot floats over your screen, listens when you ask it to, and answers from your briefing packs. Ctrl+Shift+Space hides it, Ctrl+Shift+K hides just the Knot, and Ctrl+Shift+X stops and vanishes in one stroke.',action:{label:'Show me the Knot',run:async()=>{await api.companionControl?.('tour');}}},
  {view:'history',rail:'companion',title:'Every session is kept',body:'Transcripts from the Companion land here, searchable, with the briefing pack that was live at the time. Any session can be uploaded into your Jarvis vault as a note, and you see the exact markdown before it is written.'},
  {view:'settings',rail:'settings',title:'Settings is where the wiring lives',body:'Your two AI keys, email and calendar connections, Companion options, and your school\'s GPA scale all live here. The next three steps cover the ones you actually have to do.'},
  {view:'settings',rail:'settings',title:'Key 1 of 2: Claude, for the desktop app',body:'The AI provider card on this page. Claude reads your syllabi and powers the Ask bar and the chat thread. If Claude Code is installed on this machine, Nūs finds it automatically and there is nothing to paste. If not, put an Anthropic API key in that card. It is encrypted on this device and only ever used to call Anthropic.'},
  {view:'settings',rail:'settings',title:'Key 2 of 2: Gemini, for the Companion',body:'The Companion AI key card, right below the AI provider one. The floating Knot is a separate agent: it sees your screen and listens, so it runs on its own provider to stay fast and cheap. Paste a Google Gemini key there (the free tier at aistudio.google.com/apikey is enough) and the Knot starts answering. Until it has that key it will only say it needs one. The Knot\'s own gear icon sets the same key if you prefer.'},
  {view:'settings',rail:'settings',title:'Fix your GPA scale',body:'Scroll to the GPA scale card, or click Data in the left column. Every school maps percentages to letters differently, so match that table to your syllabus or the registrar once. Semester setup and every GPA projection read from it, and Nūs never guesses a missing row.'},
  {view:'companion',rail:'companion',title:'Driving the Companion',body:'On screen: click the Knot to open its command sheet, then type a question or press Ctrl+Enter for Assist. The buttons are the shortcuts. Ctrl+Shift+Space hides or shows it, Ctrl+Shift+K hides just the Knot mark, Ctrl+Shift+X stops listening and vanishes. It keeps running with the hotkeys live after you close this dashboard, and the tray icon brings the dashboard back. Turn off Companion on this pane removes it entirely.'},
  {view:'today',rail:null,title:'You are set',body:'That is the tour. Anything you import lands in a review table before it is saved, so nothing enters your semester without you seeing it. You can replay this walkthrough any time from Settings.',done:true},
];

let focusPicked=[];
let tourIndex=0;
let welcomeTimer=null;

function renderFocusPicker(){
  $('#onboard-content').innerHTML=`<div class="section-kicker">Before we start</div><h2>What are you carrying this semester?</h2><p>Pick everything that applies. Nūs will shape the first week around it.</p><div class="choice-grid">${focusOptions.map(([label,detail])=>`<div class="choice-card${focusPicked.includes(label)?' active':''}" data-focus="${esc(label)}"><strong>${esc(label)}</strong><span>${esc(detail)}</span></div>`).join('')}</div>`;
  $('#onboard-dots').innerHTML='';
  $('#onboard-back').style.visibility='hidden';
  $('#onboard-next').textContent=focusPicked.length?`Continue with ${focusPicked.length}`:'Continue';
  $('#onboard-skip').textContent='Skip';
}
$('#onboard-content').addEventListener('click',(event)=>{
  const card=event.target.closest('[data-focus]'); if(!card)return;
  const label=card.dataset.focus;
  focusPicked=focusPicked.includes(label)?focusPicked.filter((item)=>item!==label):[...focusPicked,label];
  renderFocusPicker();
});

function companionWelcome(){
  const courses=state.data.courses.length;
  const next=state.data.ranked[0];
  const open=state.data.tasks.filter((task)=>!task.done).length;
  const promises=focusPicked.map((label)=>focusPromise[label]).filter(Boolean).slice(0,3);
  const paragraphs=[
    'Hey. I am your Companion, and I run on whatever you confirm in here. Nothing else.',
    promises.length
      ? `You told me you are carrying ${focusPicked.slice(0,3).join(', ').toLowerCase()}. So here is what I will do with that: ${promises.join('; ')}. Import one real syllabus and I can start doing it today.`
      : 'You skipped the picker, which is fine. Import one real syllabus and I will start from what is actually in it.',
    courses
      ? `Right now I have ${courses} course${courses===1?'':'s'} and ${open} open task${open===1?'':'s'} to work with.${next?` ${next.title} is the clearest next move: ${next.reason.toLowerCase()}`:''}`
      : 'Right now I have nothing to work with, so Today is honest about being empty rather than filling itself with sample data.',
    'Quick lay of the land. Today ranks your next move and tells you why it won. Map sits right under it: every course, source, and task as something you can drag, pan, and zoom. Calendar is the month as it actually is. Smart tasks breaks an outcome into steps you can check off. Under Jarvis you will find me on screen, plus the transcript of every session I have listened to.',
    'One thing worth knowing since it shapes how you use this. I never invent a date or a grade. Everything I read lands in a review table first and waits for you to confirm it, which is why the numbers here are worth trusting.',
    'So, do you want to import a syllabus and watch the whole loop run, or poke around first and ask me things?',
  ];
  return paragraphs;
}
function streamWelcome(){
  clearInterval(welcomeTimer);
  const paragraphs=companionWelcome();
  const answer=$('#ask-answer');
  answer.innerHTML='';
  answer.classList.remove('hidden');
  let index=0;
  const push=()=>{
    if(index>=paragraphs.length){clearInterval(welcomeTimer);welcomeTimer=null;return;}
    const p=document.createElement('p');
    p.textContent=paragraphs[index];
    answer.appendChild(p);
    answer.scrollTop=answer.scrollHeight;
    index+=1;
  };
  push();
  welcomeTimer=setInterval(push,2600);
}

function positionCoach(step){
  const card=$('#coach-card');
  $$('.nav-item').forEach((item)=>item.classList.remove('coach-target'));
  if(!step.rail){card.classList.add('centered');card.style.top='';card.style.left='';return;}
  card.classList.remove('centered');
  const target=$(`.nav-item[data-view="${step.rail}"]`);
  if(!target)return;
  target.classList.add('coach-target');
  const rect=target.getBoundingClientRect();
  const top=Math.max(18,Math.min(rect.top-12,window.innerHeight-card.offsetHeight-24));
  card.style.top=`${top}px`;
  card.style.left='262px';
}
function renderCoach(){
  const step=tourSteps[tourIndex];
  setView(step.view);
  $('#coach-step').textContent=step.done?'Done':`Step ${tourIndex+1} of ${tourSteps.length}`;
  $('#coach-title').textContent=step.title;
  $('#coach-body').textContent=step.body;
  const actions=$('#coach-actions');
  if(actions){
    actions.innerHTML='';
    if(step.action){
      const btn=document.createElement('button');
      btn.type='button';btn.className='coach-action';btn.textContent=step.action.label;
      btn.addEventListener('click',step.action.run);
      actions.appendChild(btn);
    }
  }
  $('#coach-dots').innerHTML=tourSteps.map((_,index)=>`<i class="${index===tourIndex?'active':''}"></i>`).join('');
  $('#coach-back').style.visibility=tourIndex?'visible':'hidden';
  $('#coach-next').textContent=step.done?'Finish':tourIndex===tourSteps.length-2?'Wrap up':'Next';
  positionCoach(step);
}
function beginCoach(){
  tourIndex=0;
  $('#coach-scrim').classList.remove('hidden');
  $('#coach-card').classList.remove('hidden');
  renderCoach();
  streamWelcome();
}
async function finishOnboard(){
  clearInterval(welcomeTimer); welcomeTimer=null;
  $$('.nav-item').forEach((item)=>item.classList.remove('coach-target'));
  $('#onboard-scrim').classList.add('hidden');
  $('#coach-scrim').classList.add('hidden');
  $('#coach-card').classList.add('hidden');
  await api.setPreference('onboarded',true);
}
$('#onboard-next').addEventListener('click',async()=>{
  await api.setPreference('focus_areas',focusPicked);
  $('#onboard-scrim').classList.add('hidden');
  beginCoach();
});
$('#onboard-back').addEventListener('click',()=>renderFocusPicker());
$('#onboard-skip').addEventListener('click',finishOnboard);
$('#coach-next').addEventListener('click',()=>{
  if(tourIndex>=tourSteps.length-1){finishOnboard();return;}
  tourIndex+=1; renderCoach();
});
$('#coach-back').addEventListener('click',()=>{tourIndex=Math.max(0,tourIndex-1);renderCoach();});
$('#coach-close').addEventListener('click',finishOnboard);
$('#replay-tour').addEventListener('click',()=>{focusPicked=state.data.preferences.focus_areas||[];renderFocusPicker();$('#onboard-scrim').classList.remove('hidden');});
window.addEventListener('resize',()=>{if(!$('#coach-card').classList.contains('hidden'))positionCoach(tourSteps[tourIndex]);});

async function start(){await load();setView('today');if(!state.data.preferences.onboarded){focusPicked=state.data.preferences.focus_areas||[];renderFocusPicker();$('#onboard-scrim').classList.remove('hidden');}}
start().catch((error)=>{console.error(error);showToast('Nūs could not read the local semester.');});

function createPreviewApi(){
  const today=isoDay(),plus=(days)=>{const d=new Date();d.setDate(d.getDate()+days);return isoDay(d);};
  const data={courses:[{id:1,name:'Linear Algebra',code:'MATH 2418',credit_hours:4},{id:2,name:'Computer Science II',code:'COSC 1437',credit_hours:4}],assignments:[{id:1,course_id:1,title:'Matrix transformations set',due_date:plus(1),status:'pending'},{id:2,course_id:2,title:'Linked list lab',due_date:plus(3),status:'pending'}],tasks:[{id:1,title:'Study for linear algebra midterm',course_name:'Linear Algebra',due_date:plus(5),done:0,estimated_minutes:100,steps:[{id:1,title:'Collect the exact topics and materials',done:1,estimated_minutes:20},{id:2,title:'Run a quick diagnostic without notes',done:0,estimated_minutes:20},{id:3,title:'Review the weakest two topics',done:0,estimated_minutes:20},{id:4,title:'Complete a timed practice pass',done:0,estimated_minutes:20},{id:5,title:'Write the one-page final review sheet',done:0,estimated_minutes:20}]}],sources:[{id:1,title:'Fall 2026 calendar.ics',source_type:'calendar_file'}],integrations:[['calendar_file','Calendar file','connected','12 events imported locally.'],['google_calendar','Google Calendar','needs_credentials','OAuth client ID required before live sync can be enabled.'],['canvas','Canvas','needs_credentials','Requires your school Canvas domain and an approved OAuth client.'],['blackboard','Blackboard','needs_admin','Requires an Anthology app registration and campus approval.'],['chatgpt_export','ChatGPT history','ready','Import an exported JSON or HTML archive locally.'],['claude_export','Claude history','ready','Import exported JSON, HTML, Markdown, or text locally.'],['google_docs','Google Docs','ready','Import downloaded Docs as PDF, DOCX, Markdown, or text.'],['icloud_notes','iCloud Notes','ready','Import exported notes as HTML, Markdown, or text.']].map(([provider,label,status,detail])=>({provider,label,status,detail})),automations:[{id:1,name:'Weekly calculus review',trigger_type:'weekly',enabled:1,run_count:2}],repeated_signals:[{recurrence_key:'weekly review',occurrences:3,example_title:'Weekly chapter review'}],preferences:{onboarded:true},activity:[{id:2,action_type:'assistant_reschedule',summary:'Assignment 3 due date updated',detail:'Changed in memory and Calendar using your Linear Algebra syllabus context.',status:'done',created_at:new Date(Date.now()-1800000).toISOString()},{id:1,action_type:'assistant_draft',summary:'Professor absence email drafted',detail:'Used "Dr. Ibarra," your section number, and your usual professional tone.',status:'review',created_at:new Date(Date.now()-3600000).toISOString()}],ranked:[{id:1,title:'Matrix transformations set',due_date:plus(1),course_name:'Linear Algebra',days_left:1,reason:'Due tomorrow in Linear Algebra.'},{id:2,title:'Linked list lab',due_date:plus(3),course_name:'Computer Science II',days_left:3,reason:'Due in 3 days.'}],gpa:{overall:3.54,courses:[{course:'Linear Algebra',letter:'A-',known_weight:30,assumed_weight:70},{course:'Computer Science II',letter:'B+',known_weight:45,assumed_weight:55}]}};
  return {getState:async()=>data,updateTask:async()=>{},updateTaskStep:async()=>{},updateAssignment:async(id)=>{data.assignments=data.assignments.filter((a)=>a.id!==id);data.ranked=data.ranked.filter((r)=>r.id!==id);},addTask:async(task)=>{task.id=Date.now();task.course_name='General';task.done=0;task.steps=[1,2,3,4,5].map((id,index)=>({id:Date.now()+id,title:['Define what done looks like','Prepare the materials','Complete the first pass','Resolve the main blocker','Review and close'][index],done:0,estimated_minutes:12}));data.tasks.unshift(task);},setPreference:async(key,value)=>{data.preferences[key]=value;},importSource:async()=>({canceled:false,imported:4,fileName:'semester.ics'}),aiStatus:async()=>({cli:true,apiKey:false,encryptionAvailable:true}),aiSetKey:async()=>({ok:true}),aiClearKey:async()=>({ok:true}),aiTest:async()=>({ok:true}),syllabusImport:async()=>({sourceId:1,fileName:'COSC 1437 Syllabus.pdf',data:{course:{name:'Computer Science II',code:'COSC 1437',credit_hours:4,term:'Fall 2026'},grade_weights:[{category:'Homework',weight_pct:20},{category:'Labs',weight_pct:20},{category:'Midterm',weight_pct:25},{category:'Final',weight_pct:35}],assignments:[{title:'Linked list lab',due_date:plus(6),category:'Labs'},{title:'Homework 1: recursion',due_date:plus(9),category:'Homework'},{title:'Midterm exam',due_date:plus(30),category:'Midterm'}]}}),syllabusExtract:async()=>({error:'source_missing'}),syllabusConfirm:async()=>({ok:true,courseId:3,assignments:3,weights:4}),authConfig:async()=>({supabase:false,googleCalendar:false,outlook:true}),outlookStatus:async()=>({configured:true,connected:true,email:'you@utdallas.edu'}),outlookInbox:async()=>({messages:[{subject:'Assignment 3 deadline moved to Friday',from_name:'Dr. Lina Ibarra',from_address:'ibarra@utdallas.edu',received_at:new Date(Date.now()-3600000).toISOString(),preview:'Canvas will update tonight. The new deadline is Friday at 11:59pm.',unread:true,important:false},{subject:'Fall internship fair registration opens',from_name:'UTD Career Center',from_address:'careers@utdallas.edu',received_at:new Date(Date.now()-7200000).toISOString(),preview:'Registration opens this week for the fall fair.',unread:false,important:false}]}),styleProfile:async()=>({ready:true,exemplars:38,formality:'balanced',avgSentenceWords:16}),listActivity:async()=>data.activity,assistantParse:async(text)=>{const isQ=/\?|what|how|when|should/i.test(text);return isQ?{proposal:{command:{intent:'question',question:text,summary_for_user:''},resolved:{},notes:[],needs_confirm:false}}:{proposal:{command:{intent:'add_task',title:text.slice(0,60),due_date:plus(1),summary_for_user:`Create task "${text.slice(0,40)}" due tomorrow.`,confidence:0.9},resolved:{},notes:[],needs_confirm:true}};},assistantExecute:async()=>({ok:true,message:'Done (preview).'}),authSession:async()=>({user:null,configured:false}),syncStatus:async()=>({configured:false,authenticated:false,enabled:false}),addAutomation:async(item)=>{data.automations.unshift({...item,id:Date.now(),enabled:1,run_count:0});},updateAutomation:async()=>{},bridgeStatus:async()=>({connected:true,updated_at:new Date().toISOString()}),storageStatus:async()=>({dbBytes:4823040,sourceBytes:2411520,capBytes:536870912}),
    companionStatus:async()=>({running:true,visible:true,capturing:false,stealth:false}),
    companionControl:async(action)=>({running:true,visible:action!=='hide',capturing:action==='capture-start',stealth:false}),
    companionSessions:async()=>([{id:1,started_at:new Date(Date.now()-5400000).toISOString(),ended_at:new Date(Date.now()-3600000).toISOString(),pack:'demo-brief',title:'Pricing objection walkthrough',message_count:6,first_line:'Pricing objection walkthrough'}]),
    companionMessages:async()=>([{id:1,session_id:1,ts:new Date(Date.now()-5400000).toISOString(),channel:'them',text:'The seat pricing feels steep for a student org.',mode:null},{id:2,session_id:1,ts:new Date(Date.now()-5380000).toISOString(),channel:'you',text:'What is the counter on per-seat cost?',mode:'ask'},{id:3,session_id:1,ts:new Date(Date.now()-5375000).toISOString(),channel:'nus',text:'Anchor on outcome per member, not seat: the pack shows a 3x turnaround on sponsor replies.',mode:'ask'}]),
    companionSearch:async()=>([{session_id:1}]),
    companionVaultPreview:async()=>({fileName:'2026-08-18-pricing-objection-walkthrough.md',dir:'(your vault)\\notes\\companion',vaultOk:true,content:'---\ntitle: "Companion session: Pricing objection walkthrough"\ndate: 2026-08-18\ntags: [companion, transcript, meeting]\ncategory: note\n---\n\n(preview)'}),
    companionVaultWrite:async()=>({ok:true,path:'notes/companion/2026-08-18-pricing-objection-walkthrough.md'}),
    onCompanionState:()=>{},onCompanionMessage:()=>{}};
}
