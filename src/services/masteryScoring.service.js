// Deterministic mastery scoring — no AI involved here on purpose, same as
// pyqFrequency.service.js's historical-importance scoring. Whether a
// student is answering a topic's quiz questions correctly is a fact
// computed directly from QuizAttemptAnswer rows; there's nothing for an LLM
// to judge, and a wrong "you've mastered this" verdict from a model would be
// actively harmful to how someone allocates their remaining study time.
//
// Mastery = a recency-weighted accuracy across a topic's quiz attempts.
// Recent performance outweighs an old streak that may no longer reflect
// what the student currently knows, the same half-life-decay idea Phase 6
// uses for recency — just applied to the student's own answers instead of
// exam-year coverage.
const DEFAULT_CONFIG = {
  // Each half-life back in time, an answer's contribution to the score is
  // halved.
  recencyHalfLifeDays: 21,
  // Below this many attempts the score is still returned, but flagged
  // low-confidence — a single lucky/unlucky answer shouldn't read as a
  // verdict.
  minAttemptsForConfidence: 3,
  weakThreshold: 0.5,
  strongThreshold: 0.8,
};

/**
 * @param {Array<{isCorrect: boolean, completedAt: Date|string}>} answers - this user's QuizAttemptAnswer rows for one topic
 * @param {number} now - reference timestamp (ms since epoch) for recency decay
 * @param {Object} [config] - overrides merged onto DEFAULT_CONFIG
 * @returns {{score: number, level: 'NOT_STARTED'|'WEAK'|'DEVELOPING'|'STRONG', accuracy: number, attemptCount: number, lowConfidence: boolean}}
 */
function computeTopicMastery(answers, now, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (!answers || answers.length === 0) {
    return { score: 0, level: 'NOT_STARTED', accuracy: 0, attemptCount: 0, lowConfidence: true };
  }

  const attemptCount = answers.length;
  const correctCount = answers.filter((a) => a.isCorrect).length;
  const accuracy = Math.round((correctCount / attemptCount) * 100) / 100;

  const { weightedSum, weightTotal } = answers.reduce(
    (acc, a) => {
      const ageDays = Math.max(0, (now - new Date(a.completedAt).getTime()) / (1000 * 60 * 60 * 24));
      const weight = Math.pow(0.5, ageDays / cfg.recencyHalfLifeDays);
      return {
        weightedSum: acc.weightedSum + (a.isCorrect ? weight : 0),
        weightTotal: acc.weightTotal + weight,
      };
    },
    { weightedSum: 0, weightTotal: 0 }
  );

  const rawScore = weightTotal === 0 ? 0 : weightedSum / weightTotal;
  const score = Math.round(rawScore * 100) / 100;

  const level = score >= cfg.strongThreshold ? 'STRONG' : score >= cfg.weakThreshold ? 'DEVELOPING' : 'WEAK';

  return { score, level, accuracy, attemptCount, lowConfidence: attemptCount < cfg.minAttemptsForConfidence };
}

module.exports = { computeTopicMastery, DEFAULT_CONFIG };
