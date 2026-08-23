const FREE_LIMITS = Object.freeze({
  syllabusImports: 3,
  questionsPerDay: 10,
  connectedAccounts: 1,
  automationRules: 1,
  companionMsPerDay: 20 * 60 * 1000,
  historyDays: 7,
  storageBytes: 512 * 1024 * 1024,
});

const PRO_STORAGE_BYTES = 2 * 1024 * 1024 * 1024;

function localDay(timestamp) {
  const date = new Date(timestamp);
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function createLimits({ db, license, clock = () => Date.now() }) {
  const isPro = () => Boolean(license.status().isPro);
  const prefs = () => db.getPreferences();

  function limitError(error, limit) {
    return { ok: false, error, limit, upgrade: true };
  }

  function syllabusAllowed(sourceId) {
    if (isPro()) return { ok: true };
    const used = Array.isArray(prefs().usage_syllabus_sources) ? prefs().usage_syllabus_sources : [];
    if (used.includes(Number(sourceId))) return { ok: true };
    if (used.length >= FREE_LIMITS.syllabusImports) return limitError('limit_syllabus_imports', FREE_LIMITS.syllabusImports);
    return { ok: true };
  }

  function recordSyllabus(sourceId) {
    if (isPro()) return;
    const used = Array.isArray(prefs().usage_syllabus_sources) ? prefs().usage_syllabus_sources : [];
    const id = Number(sourceId);
    if (!used.includes(id)) db.setPreference('usage_syllabus_sources', [...used, id]);
  }

  function reserveQuestion() {
    if (isPro()) return { ok: true, rollback() {} };
    const day = localDay(clock());
    const saved = prefs().usage_questions_daily;
    const count = saved?.day === day ? Number(saved.count) || 0 : 0;
    if (count >= FREE_LIMITS.questionsPerDay) return limitError('limit_questions', FREE_LIMITS.questionsPerDay);
    db.setPreference('usage_questions_daily', { day, count: count + 1 });
    let live = true;
    return {
      ok: true,
      rollback() {
        if (!live) return;
        live = false;
        const current = prefs().usage_questions_daily;
        if (current?.day === day) db.setPreference('usage_questions_daily', { day, count: Math.max(0, (Number(current.count) || 1) - 1) });
      },
    };
  }

  function connectedAccountAllowed(provider, statuses) {
    if (isPro() || statuses?.[provider]) return { ok: true };
    const connected = Object.values(statuses || {}).filter(Boolean).length;
    return connected >= FREE_LIMITS.connectedAccounts
      ? limitError('limit_connected_accounts', FREE_LIMITS.connectedAccounts)
      : { ok: true };
  }

  function automationAllowed(existingCount) {
    if (isPro() || Number(existingCount) < FREE_LIMITS.automationRules) return { ok: true };
    return limitError('limit_automation_rules', FREE_LIMITS.automationRules);
  }

  function companionUsedMs() {
    const day = localDay(clock());
    const saved = prefs().usage_companion_daily;
    return saved?.day === day ? Math.max(0, Number(saved.ms) || 0) : 0;
  }

  function companionAllowanceMs() {
    if (isPro()) return Number.POSITIVE_INFINITY;
    return Math.max(0, FREE_LIMITS.companionMsPerDay - companionUsedMs());
  }

  function recordCompanionMs(durationMs) {
    if (isPro()) return;
    const day = localDay(clock());
    db.setPreference('usage_companion_daily', {
      day,
      ms: Math.min(FREE_LIMITS.companionMsPerDay, companionUsedMs() + Math.max(0, Number(durationMs) || 0)),
    });
  }

  function historyCutoff() {
    return isPro() ? null : new Date(clock() - FREE_LIMITS.historyDays * 86400000).toISOString();
  }

  function storageCapBytes() {
    return isPro() ? PRO_STORAGE_BYTES : FREE_LIMITS.storageBytes;
  }

  function summary() {
    const usedSources = Array.isArray(prefs().usage_syllabus_sources) ? prefs().usage_syllabus_sources.length : 0;
    const dailyQuestions = prefs().usage_questions_daily;
    const questionCount = dailyQuestions?.day === localDay(clock()) ? Number(dailyQuestions.count) || 0 : 0;
    return {
      plan: isPro() ? 'pro' : 'free',
      syllabusImports: { used: usedSources, limit: isPro() ? null : FREE_LIMITS.syllabusImports },
      questions: { used: questionCount, limit: isPro() ? null : FREE_LIMITS.questionsPerDay },
      companionMs: { used: companionUsedMs(), limit: isPro() ? null : FREE_LIMITS.companionMsPerDay },
      historyDays: isPro() ? null : FREE_LIMITS.historyDays,
      storageBytes: storageCapBytes(),
    };
  }

  return {
    syllabusAllowed, recordSyllabus, reserveQuestion, connectedAccountAllowed,
    automationAllowed, companionAllowanceMs, recordCompanionMs, historyCutoff,
    storageCapBytes, summary,
  };
}

module.exports = { createLimits, FREE_LIMITS, PRO_STORAGE_BYTES, localDay };
