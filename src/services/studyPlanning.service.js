// Deterministic study-plan scheduling — no AI involved, same reasoning as
// pyqFrequency.service.js and masteryScoring.service.js. Deciding which
// already-scored topic gets which day's minutes is an allocation problem
// with a correct, checkable answer; there's nothing here for an LLM to add
// except unpredictability.
//
// Priority per topic blends two signals this app already computes:
//  - weakness  = 1 - mastery score (Phase 8) — the student's own performance
//  - importance = PYQ historical-importance score (Phase 6) — how often the
//    topic has actually shown up in past papers
// Topics the student has confidently mastered (STRONG, not low-confidence)
// are excluded entirely — spaced revision of already-known material is
// Phase 10's job, not first-pass study time here.
//
// Slots are handed out via Smooth Weighted Round Robin (the same algorithm
// load balancers use to distribute requests proportionally to weight
// without clustering them) so a high-priority topic gets proportionally
// more sessions across the whole horizon instead of monopolizing day one.
const DAY_MS = 24 * 60 * 60 * 1000;

const DEFAULT_CONFIG = {
  sessionUnitMinutes: 30,
  // No single topic can fill more than this fraction of one day's budget —
  // forces variety instead of one weak topic burning out the whole day.
  // Kept above 0.5 deliberately: at exactly half, two competing topics get
  // forced into an even split every day regardless of how differently
  // they're prioritized, which defeats the point of weighting them at all.
  maxTopicMinutesPerDayRatio: 0.65,
  weights: { weakness: 0.6, importance: 0.4 },
  // PYQ data may simply not exist for a topic yet (no papers uploaded) —
  // treated as neutral, never as evidence the topic is unimportant.
  defaultImportanceWhenUnknown: 0.5,
};

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

function buildReason(topic) {
  const base =
    topic.masteryLevel === 'NOT_STARTED'
      ? 'Not started yet'
      : topic.masteryLevel === 'WEAK'
        ? 'Weak area — needs focused practice'
        : 'Still developing';
  const importanceNote = (topic.importanceScore ?? 0) >= 0.6 ? ' · frequently tested in past papers' : '';
  return base + importanceNote;
}

/**
 * @param {Array<{topicId: string, topicName: string, subtopicId?: string|null, masteryScore: number, masteryLevel: string, lowConfidence: boolean, importanceScore?: number|null}>} topics
 * @param {Date} today
 * @param {Date} examDate
 * @param {number} availableHoursPerDay
 * @param {Object} [config]
 * @returns {{days: Array<{date: Date, sessions: Array<{topicId, topicName, subtopicId, durationMinutes, priorityScore, reason}>}>, skippedTopicIds: string[]}}
 */
function buildStudyPlan(topics, today, examDate, availableHoursPerDay, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config, weights: { ...DEFAULT_CONFIG.weights, ...(config.weights || {}) } };

  const start = startOfDay(today);
  const end = startOfDay(examDate);
  const daysUntilExam = Math.max(1, Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1);

  const mastered = topics.filter((t) => t.masteryLevel === 'STRONG' && !t.lowConfidence);
  const scored = topics
    .filter((t) => !(t.masteryLevel === 'STRONG' && !t.lowConfidence))
    .map((t) => {
      const weakness = 1 - (t.masteryScore ?? 0);
      const importance = t.importanceScore ?? cfg.defaultImportanceWhenUnknown;
      const priorityScore = Math.round((cfg.weights.weakness * weakness + cfg.weights.importance * importance) * 100) / 100;
      return { ...t, priorityScore, currentWeight: 0 };
    })
    .sort((a, b) => b.priorityScore - a.priorityScore || a.topicName.localeCompare(b.topicName));

  if (scored.length === 0) {
    return { days: [], skippedTopicIds: mastered.map((t) => t.topicId) };
  }

  // Fixed for the whole run — Smooth Weighted Round Robin assumes a stable
  // total weight across picks, only which topic currently "has the turn"
  // changes.
  const totalWeight = scored.reduce((sum, t) => sum + t.priorityScore, 0) || scored.length;
  const dailyBudgetMinutes = Math.round(availableHoursPerDay * 60);
  const perTopicDailyCap = Math.max(cfg.sessionUnitMinutes, Math.floor(dailyBudgetMinutes * cfg.maxTopicMinutesPerDayRatio));

  const days = [];
  for (let d = 0; d < daysUntilExam; d++) {
    const date = new Date(start.getTime() + d * DAY_MS);
    let remaining = dailyBudgetMinutes;
    const usedToday = new Map(scored.map((t) => [t.topicId, 0]));
    const sessions = [];

    while (remaining >= cfg.sessionUnitMinutes) {
      const candidates = scored.filter((t) => usedToday.get(t.topicId) < perTopicDailyCap);
      if (candidates.length === 0) break; // every eligible topic hit its per-day cap

      candidates.forEach((t) => {
        t.currentWeight += t.priorityScore || 0.01; // a 0-priority topic still gets an occasional turn
      });
      const picked = candidates.reduce((best, t) => (!best || t.currentWeight > best.currentWeight ? t : best), null);
      picked.currentWeight -= totalWeight;

      usedToday.set(picked.topicId, usedToday.get(picked.topicId) + cfg.sessionUnitMinutes);
      remaining -= cfg.sessionUnitMinutes;

      const existing = sessions.find((s) => s.topicId === picked.topicId);
      if (existing) existing.durationMinutes += cfg.sessionUnitMinutes;
      else {
        sessions.push({
          topicId: picked.topicId,
          topicName: picked.topicName,
          subtopicId: picked.subtopicId || null,
          durationMinutes: cfg.sessionUnitMinutes,
          priorityScore: picked.priorityScore,
          reason: buildReason(picked),
        });
      }
    }

    days.push({ date, sessions });
  }

  return { days, skippedTopicIds: mastered.map((t) => t.topicId) };
}

module.exports = { buildStudyPlan, startOfDay, DEFAULT_CONFIG };
