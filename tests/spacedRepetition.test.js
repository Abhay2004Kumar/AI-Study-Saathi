const { applyReview, DEFAULT_EASE_FACTOR } = require('../src/services/spacedRepetition.service');
const { normalizeFrontText, dedupeFlashcards } = require('../src/ai/services/flashcard.service');

describe('SM-2 spaced repetition (unit, deterministic, no AI/DB)', () => {
  const NOW = new Date('2026-08-26T00:00:00Z');
  const freshCard = { easeFactor: DEFAULT_EASE_FACTOR, intervalDays: 0, repetitions: 0 };

  it('schedules a brand-new card one day out on GOOD', () => {
    const result = applyReview(freshCard, 'GOOD', NOW);
    expect(result.repetitions).toBe(1);
    expect(result.intervalDays).toBe(1);
    expect(result.dueAt.getTime()).toBe(NOW.getTime() + 24 * 60 * 60 * 1000);
  });

  it('schedules the second successful review six days out', () => {
    const afterFirst = applyReview(freshCard, 'GOOD', NOW);
    const afterSecond = applyReview(afterFirst, 'GOOD', NOW);
    expect(afterSecond.repetitions).toBe(2);
    expect(afterSecond.intervalDays).toBe(6);
  });

  it('grows the interval by the ease factor from the third review onward', () => {
    let card = freshCard;
    card = applyReview(card, 'GOOD', NOW);
    card = applyReview(card, 'GOOD', NOW);
    const third = applyReview(card, 'GOOD', NOW);
    expect(third.repetitions).toBe(3);
    expect(third.intervalDays).toBe(Math.round(6 * card.easeFactor));
  });

  it('resets repetitions and interval to 1 day on AGAIN, regardless of prior progress', () => {
    let card = freshCard;
    card = applyReview(card, 'GOOD', NOW);
    card = applyReview(card, 'GOOD', NOW);
    card = applyReview(card, 'GOOD', NOW); // several successful reviews in
    const forgotten = applyReview(card, 'AGAIN', NOW);
    expect(forgotten.repetitions).toBe(0);
    expect(forgotten.intervalDays).toBe(1);
  });

  it('never lets the ease factor drop below the floor even after repeated AGAIN grades', () => {
    let card = freshCard;
    for (let i = 0; i < 20; i++) {
      card = applyReview(card, 'AGAIN', NOW);
    }
    expect(card.easeFactor).toBeGreaterThanOrEqual(1.3);
  });

  it('gives EASY a larger ease-factor boost than GOOD, and HARD a smaller one', () => {
    const easy = applyReview(freshCard, 'EASY', NOW);
    const good = applyReview(freshCard, 'GOOD', NOW);
    const hard = applyReview(freshCard, 'HARD', NOW);
    expect(easy.easeFactor).toBeGreaterThan(good.easeFactor);
    expect(good.easeFactor).toBeGreaterThan(hard.easeFactor);
  });

  it('sets lastReviewedAt to the review time', () => {
    const result = applyReview(freshCard, 'GOOD', NOW);
    expect(result.lastReviewedAt.getTime()).toBe(NOW.getTime());
  });

  it('rejects an unknown grade rather than silently defaulting', () => {
    expect(() => applyReview(freshCard, 'MAYBE', NOW)).toThrow();
  });

  it('is fully deterministic given the same inputs', () => {
    const a = applyReview(freshCard, 'GOOD', NOW);
    const b = applyReview(freshCard, 'GOOD', NOW);
    expect(a).toEqual(b);
  });
});

describe('Flashcard dedup (unit, deterministic, no AI/DB)', () => {
  it('normalizes case and whitespace for comparison', () => {
    expect(normalizeFrontText('  What IS   a Deadlock?  ')).toBe('what is a deadlock?');
  });

  it('drops a duplicate within the same generated batch, keeping the first', () => {
    const result = dedupeFlashcards([
      { front: 'What is a deadlock?', back: 'A' },
      { front: '  what is a deadlock?  ', back: 'B' },
      { front: 'What is thrashing?', back: 'C' },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0].back).toBe('A');
  });

  it('drops a card that duplicates one already persisted for the topic', () => {
    const existing = new Set(['what is a deadlock?']);
    const result = dedupeFlashcards([{ front: 'What is a deadlock?', back: 'A' }, { front: 'What is thrashing?', back: 'B' }], existing);
    expect(result).toHaveLength(1);
    expect(result[0].front).toBe('What is thrashing?');
  });

  it('drops a card with a blank front', () => {
    const result = dedupeFlashcards([{ front: '   ', back: 'A' }, { front: 'Real card', back: 'B' }]);
    expect(result).toHaveLength(1);
  });
});
