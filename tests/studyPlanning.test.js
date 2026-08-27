const { buildStudyPlan } = require('../src/services/studyPlanning.service');

describe('Study plan scheduling (unit, deterministic, no AI/DB)', () => {
  const TODAY = new Date('2026-08-01T00:00:00Z');
  const EXAM_IN_5_DAYS = new Date('2026-08-05T00:00:00Z'); // 5-day horizon inclusive

  const weakTopic = {
    topicId: 'weak',
    topicName: 'Weak Topic',
    masteryScore: 0.1,
    masteryLevel: 'WEAK',
    lowConfidence: false,
    importanceScore: 0.8,
  };
  const developingTopic = {
    topicId: 'developing',
    topicName: 'Developing Topic',
    masteryScore: 0.6,
    masteryLevel: 'DEVELOPING',
    lowConfidence: false,
    importanceScore: 0.3,
  };
  const strongConfidentTopic = {
    topicId: 'strong',
    topicName: 'Strong Topic',
    masteryScore: 0.95,
    masteryLevel: 'STRONG',
    lowConfidence: false,
    importanceScore: 0.5,
  };
  const strongLowConfidenceTopic = {
    topicId: 'strong-shaky',
    topicName: 'Shaky Strong Topic',
    masteryScore: 0.9,
    masteryLevel: 'STRONG',
    lowConfidence: true,
    importanceScore: 0.5,
  };

  it('produces exactly one entry per calendar day through the exam date, inclusive', () => {
    const { days } = buildStudyPlan([weakTopic], TODAY, EXAM_IN_5_DAYS, 2);
    expect(days.length).toBe(5); // Aug 1, 2, 3, 4, 5
  });

  it('excludes a confidently-mastered (STRONG, not low-confidence) topic entirely', () => {
    const { days, skippedTopicIds } = buildStudyPlan([weakTopic, strongConfidentTopic], TODAY, EXAM_IN_5_DAYS, 2);
    expect(skippedTopicIds).toEqual(['strong']);
    days.forEach((day) => {
      expect(day.sessions.some((s) => s.topicId === 'strong')).toBe(false);
    });
  });

  it('still includes a STRONG-but-low-confidence topic, at reduced priority', () => {
    const { days } = buildStudyPlan([weakTopic, strongLowConfidenceTopic], TODAY, EXAM_IN_5_DAYS, 4);
    const totalMinutes = (topicId) =>
      days.reduce((sum, day) => sum + day.sessions.filter((s) => s.topicId === topicId).reduce((s, x) => s + x.durationMinutes, 0), 0);
    expect(totalMinutes('strong-shaky')).toBeGreaterThan(0);
    expect(totalMinutes('weak')).toBeGreaterThan(totalMinutes('strong-shaky')); // still deprioritized vs a real weak topic
  });

  it('allocates more total time to a weaker, higher-importance topic than a stronger, lower-importance one', () => {
    const { days } = buildStudyPlan([weakTopic, developingTopic], TODAY, EXAM_IN_5_DAYS, 3);
    const totalMinutes = (topicId) =>
      days.reduce((sum, day) => sum + day.sessions.filter((s) => s.topicId === topicId).reduce((s, x) => s + x.durationMinutes, 0), 0);
    expect(totalMinutes('weak')).toBeGreaterThan(totalMinutes('developing'));
  });

  it('never schedules more than the daily hour budget on any single day', () => {
    const { days } = buildStudyPlan([weakTopic, developingTopic], TODAY, EXAM_IN_5_DAYS, 1.5); // 90 min/day
    days.forEach((day) => {
      const total = day.sessions.reduce((s, x) => s + x.durationMinutes, 0);
      expect(total).toBeLessThanOrEqual(90);
    });
  });

  it('caps a single topic at a fraction of the daily budget even when it is the highest priority', () => {
    const { days } = buildStudyPlan([weakTopic, developingTopic], TODAY, EXAM_IN_5_DAYS, 4, {
      maxTopicMinutesPerDayRatio: 0.5,
    });
    const dailyBudget = 4 * 60;
    days.forEach((day) => {
      day.sessions.forEach((s) => {
        expect(s.durationMinutes).toBeLessThanOrEqual(dailyBudget * 0.5);
      });
    });
  });

  it('treats a missing importance score as neutral, not zero', () => {
    const noImportanceData = { ...developingTopic, topicId: 'no-pyq-data', importanceScore: null };
    const { days } = buildStudyPlan([noImportanceData], TODAY, EXAM_IN_5_DAYS, 1);
    // Should still get real sessions, not be starved to zero by treating
    // "no PYQ uploaded yet" as "unimportant".
    const totalMinutes = days.reduce((s, day) => s + day.sessions.reduce((x, y) => x + y.durationMinutes, 0), 0);
    expect(totalMinutes).toBeGreaterThan(0);
  });

  it('returns no sessions (only skippedTopicIds) when every topic is already confidently mastered', () => {
    const { days, skippedTopicIds } = buildStudyPlan([strongConfidentTopic], TODAY, EXAM_IN_5_DAYS, 2);
    expect(skippedTopicIds).toEqual(['strong']);
    days.forEach((day) => expect(day.sessions).toEqual([]));
  });

  it('is fully deterministic given the same inputs', () => {
    const a = buildStudyPlan([weakTopic, developingTopic], TODAY, EXAM_IN_5_DAYS, 2);
    const b = buildStudyPlan([weakTopic, developingTopic], TODAY, EXAM_IN_5_DAYS, 2);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('handles an exam date equal to today as a single-day horizon', () => {
    const { days } = buildStudyPlan([weakTopic], TODAY, TODAY, 2);
    expect(days.length).toBe(1);
  });
});
