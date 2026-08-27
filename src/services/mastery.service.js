const prisma = require('../config/db');
const { computeTopicMastery } = require('./masteryScoring.service');

// Live-computed, like Phase 6's PYQ frequency — no separate cache table to
// keep in sync (and risk going stale) after every quiz submission. The
// underlying query is cheap: a handful of QuizAttemptAnswer rows per topic.
class MasteryService {
  static async getTopicMastery(userId, topicId, config) {
    const rows = await prisma.quizAttemptAnswer.findMany({
      where: { attempt: { userId, completedAt: { not: null } }, question: { quiz: { topicId } } },
      select: { isCorrect: true, attempt: { select: { completedAt: true } } },
    });
    const answers = rows.map((r) => ({ isCorrect: r.isCorrect, completedAt: r.attempt.completedAt }));
    return computeTopicMastery(answers, Date.now(), config);
  }

  // Every topic under an exam, weakest-first — the actual "weakness" output
  // Phase 9's planner is meant to prioritize against.
  static async getExamMastery(userId, examId, config) {
    const topics = await prisma.topic.findMany({
      where: { subject: { examId } },
      select: { id: true, name: true },
    });
    if (topics.length === 0) return [];

    const topicIds = topics.map((t) => t.id);
    const rows = await prisma.quizAttemptAnswer.findMany({
      where: {
        attempt: { userId, completedAt: { not: null } },
        question: { quiz: { topicId: { in: topicIds } } },
      },
      select: {
        isCorrect: true,
        attempt: { select: { completedAt: true } },
        question: { select: { quiz: { select: { topicId: true } } } },
      },
    });

    const byTopic = new Map(topicIds.map((id) => [id, []]));
    rows.forEach((r) => {
      const topicId = r.question.quiz.topicId;
      byTopic.get(topicId)?.push({ isCorrect: r.isCorrect, completedAt: r.attempt.completedAt });
    });

    const results = topics.map((t) => ({
      topic: { id: t.id, name: t.name },
      mastery: computeTopicMastery(byTopic.get(t.id) || [], Date.now(), config),
    }));

    results.sort((a, b) => a.mastery.score - b.mastery.score);
    return results;
  }
}

module.exports = MasteryService;
