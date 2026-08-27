// Deterministic PYQ "historical importance" scoring — no AI involved here on
// purpose. Whether a topic has shown up often is a fact we can compute
// directly from PyqQuestion rows; there's nothing for an LLM to judge.
//
// Historical Importance = frequency + recency weighting + topic coverage
// (the three components the spec asks for), each normalized to [0, 1] and
// blended by configurable weights — never presented as a probability of
// appearing on the next exam, only as a relative "how often has this come
// up" signal.
const DEFAULT_CONFIG = {
  // Raw volume saturates here — one paper with 20 questions on a topic
  // shouldn't dominate over a topic that appears in every year's paper.
  frequencyCap: 5,
  // Distinct-year coverage saturates here.
  coverageCapYears: 5,
  // Each half-life back in time, a year's contribution to recency is halved.
  recencyHalfLifeYears: 3,
  weights: { frequency: 0.3, recency: 0.4, coverage: 0.3 },
  highThreshold: 0.6,
  mediumThreshold: 0.3,
};

/**
 * @param {Array<{year: number|null}>} questions - PyqQuestion-shaped rows for one topic
 * @param {number} currentYear - reference year for recency decay
 * @param {Object} [config] - overrides merged onto DEFAULT_CONFIG (including `weights`)
 * @returns {{score: number, level: 'NONE'|'LOW'|'MEDIUM'|'HIGH', yearsSeen: number[], questionCount: number}}
 */
function computeTopicFrequency(questions, currentYear, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config, weights: { ...DEFAULT_CONFIG.weights, ...config.weights } };

  if (!questions || questions.length === 0) {
    return { score: 0, level: 'NONE', yearsSeen: [], questionCount: 0 };
  }

  const uniqueYears = [...new Set(questions.map((q) => q.year).filter((y) => y != null))].sort((a, b) => a - b);

  const frequencyComponent = Math.min(questions.length / cfg.frequencyCap, 1);

  const coverageComponent = uniqueYears.length === 0 ? 0 : Math.min(uniqueYears.length / cfg.coverageCapYears, 1);

  const recencyComponent =
    uniqueYears.length === 0
      ? 0
      : uniqueYears.reduce((sum, year) => {
          const age = Math.max(0, currentYear - year);
          return sum + Math.pow(0.5, age / cfg.recencyHalfLifeYears);
        }, 0) / uniqueYears.length;

  const rawScore =
    cfg.weights.frequency * frequencyComponent +
    cfg.weights.recency * recencyComponent +
    cfg.weights.coverage * coverageComponent;
  const score = Math.round(rawScore * 100) / 100;

  const level = score >= cfg.highThreshold ? 'HIGH' : score >= cfg.mediumThreshold ? 'MEDIUM' : 'LOW';

  return { score, level, yearsSeen: uniqueYears, questionCount: questions.length };
}

module.exports = { computeTopicFrequency, DEFAULT_CONFIG };
