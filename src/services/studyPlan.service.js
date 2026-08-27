const prisma = require('../config/db');
const { buildStudyPlan, startOfDay } = require('./studyPlanning.service');
const MasteryService = require('./mastery.service');
const PyqIntelligenceService = require('../ai/services/pyqIntelligence.service');

class StudyPlanService {
  /**
   * Recomputes and persists an exam's study plan from its current topics,
   * mastery, and PYQ importance. Replaces any existing plan for this exam
   * outright — regenerating means "recompute from where things stand now",
   * not merging with stale allocations.
   *
   * @returns {Promise<{error: string}|{plan: Object, skippedTopicIds: string[]}>}
   */
  static async generate(userId, examId, config = {}) {
    const exam = await prisma.exam.findFirst({ where: { id: examId, userId } });
    if (!exam) return { error: 'NOT_FOUND' };
    if (!exam.examDate) return { error: 'MISSING_EXAM_DATE' };
    if (!exam.availableHoursPerDay || exam.availableHoursPerDay <= 0) return { error: 'MISSING_HOURS_PER_DAY' };

    const today = new Date();
    if (startOfDay(exam.examDate).getTime() < startOfDay(today).getTime()) return { error: 'EXAM_DATE_PASSED' };

    const topicsRaw = await prisma.topic.findMany({
      where: { subject: { examId } },
      select: { id: true, name: true },
    });
    if (topicsRaw.length === 0) return { error: 'NO_TOPICS' };

    const [masteryList, frequencyByTopic] = await Promise.all([
      MasteryService.getExamMastery(userId, examId),
      PyqIntelligenceService.getExamFrequency(examId),
    ]);
    const masteryByTopic = new Map(masteryList.map((m) => [m.topic.id, m.mastery]));

    const topics = topicsRaw.map((t) => {
      const mastery = masteryByTopic.get(t.id) || { score: 0, level: 'NOT_STARTED', lowConfidence: true };
      const frequency = frequencyByTopic.get(t.id);
      return {
        topicId: t.id,
        topicName: t.name,
        masteryScore: mastery.score,
        masteryLevel: mastery.level,
        lowConfidence: mastery.lowConfidence,
        importanceScore: frequency ? frequency.score : null,
      };
    });

    const built = buildStudyPlan(topics, today, exam.examDate, exam.availableHoursPerDay, config);

    await prisma.studyPlan.deleteMany({ where: { examId, userId } });
    const plan = await prisma.studyPlan.create({
      data: {
        examId,
        userId,
        startDate: startOfDay(today),
        endDate: startOfDay(exam.examDate),
        sessions: {
          create: built.days.flatMap((day) =>
            day.sessions.map((s) => ({
              date: day.date,
              topicId: s.topicId,
              subtopicId: s.subtopicId,
              durationMinutes: s.durationMinutes,
              priorityScore: s.priorityScore,
              reason: s.reason,
            }))
          ),
        },
      },
      include: { sessions: { include: { topic: { select: { id: true, name: true } } }, orderBy: { date: 'asc' } } },
    });

    return { plan, skippedTopicIds: built.skippedTopicIds };
  }

  static async getActivePlan(userId, examId) {
    return prisma.studyPlan.findUnique({
      where: { examId_userId: { examId, userId } },
      include: { sessions: { include: { topic: { select: { id: true, name: true } } }, orderBy: { date: 'asc' } } },
    });
  }

  static async setSessionCompletion(userId, sessionId, completed) {
    const session = await prisma.studyPlanSession.findFirst({ where: { id: sessionId, plan: { userId } } });
    if (!session) return null;
    return prisma.studyPlanSession.update({
      where: { id: sessionId },
      data: { completed, completedAt: completed ? new Date() : null },
    });
  }
}

module.exports = StudyPlanService;
