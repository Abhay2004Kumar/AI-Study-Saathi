// Deterministic spaced-repetition scheduling (SM-2, the classic algorithm
// behind Anki and SuperMemo) — no AI involved, same reasoning as every other
// scoring/scheduling service in this app. Given a grade for how well a card
// was recalled, there is a well-defined next interval; nothing here needs a
// model's judgment, and letting one "decide" review timing would make the
// schedule unpredictable and unauditable.
//
// Grades: AGAIN (forgot it — reset), HARD, GOOD, EASY — a simplified,
// Anki-style 4-button front end over SM-2's original 0-5 quality scale.
const GRADE_QUALITY = { AGAIN: 0, HARD: 3, GOOD: 4, EASY: 5 };

const MIN_EASE_FACTOR = 1.3;
const DEFAULT_EASE_FACTOR = 2.5;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @param {{easeFactor: number, intervalDays: number, repetitions: number}} card - current SM-2 state
 * @param {'AGAIN'|'HARD'|'GOOD'|'EASY'} grade
 * @param {Date|number} now
 * @returns {{easeFactor: number, intervalDays: number, repetitions: number, dueAt: Date, lastReviewedAt: Date}}
 */
function applyReview(card, grade, now) {
  const quality = GRADE_QUALITY[grade];
  if (quality === undefined) {
    throw new Error(`Unknown grade: ${grade}`);
  }

  const nowDate = new Date(now);
  const easeFactor = Math.max(
    MIN_EASE_FACTOR,
    (card.easeFactor ?? DEFAULT_EASE_FACTOR) + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02))
  );

  let repetitions;
  let intervalDays;
  if (quality < 3) {
    // Forgotten — the schedule resets, but the ease factor still absorbs
    // the penalty above so a card that's forgotten repeatedly keeps getting
    // shorter intervals even after it "restarts".
    repetitions = 0;
    intervalDays = 1;
  } else {
    repetitions = (card.repetitions ?? 0) + 1;
    if (repetitions === 1) intervalDays = 1;
    else if (repetitions === 2) intervalDays = 6;
    else intervalDays = Math.round((card.intervalDays || 6) * easeFactor);
  }

  return {
    easeFactor: Math.round(easeFactor * 100) / 100,
    intervalDays,
    repetitions,
    dueAt: new Date(nowDate.getTime() + intervalDays * DAY_MS),
    lastReviewedAt: nowDate,
  };
}

module.exports = { applyReview, GRADE_QUALITY, DEFAULT_EASE_FACTOR };
