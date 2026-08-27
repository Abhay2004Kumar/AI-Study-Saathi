const prisma = require('../config/db');
const AppError = require('../utils/AppError');

const syllabusInclude = {
  subjects: {
    orderBy: { orderIndex: 'asc' },
    include: {
      topics: {
        orderBy: { orderIndex: 'asc' },
        include: {
          subtopics: { orderBy: { orderIndex: 'asc' } },
        },
      },
    },
  },
};

// Catches duplicate names *within one request payload* (e.g. two topics
// named "Deadlocks" under the same subject) before we touch the database.
// The DB-level unique constraint is the backstop for names that collide with
// a sibling the payload didn't touch.
function assertNoDuplicateNames(subjectsPayload) {
  checkLevel(subjectsPayload, 'subject');
  for (const subject of subjectsPayload) {
    checkLevel(subject.topics || [], 'topic', subject.name);
    for (const topic of subject.topics || []) {
      checkLevel(topic.subtopics || [], 'subtopic', topic.name);
    }
  }
}

function checkLevel(items, label, parentName) {
  const seen = new Set();
  for (const item of items) {
    const key = normalizeName(item.name);
    if (seen.has(key)) {
      throw new AppError(
        parentName
          ? `Duplicate ${label} name "${item.name}" under "${parentName}"`
          : `Duplicate ${label} name "${item.name}"`,
        400
      );
    }
    seen.add(key);
  }
}

function normalizeName(name) {
  return name.trim().toLowerCase();
}

// Matches a payload node to an existing one: by id when given, otherwise by
// name. The name fallback matters because manual/AI-extraction payloads
// won't carry ids at all — without it, resubmitting a node whose name is
// unchanged would try to CREATE a second row before the stale one is
// deleted, tripping the (parent, name) unique constraint. A matched node is
// removed from both lookup maps so it can't be claimed twice in one pass.
function takeMatch(existingById, existingByName, input) {
  const match = (input.id && existingById.get(input.id)) || existingByName.get(normalizeName(input.name));
  if (match) {
    existingById.delete(match.id);
    existingByName.delete(normalizeName(match.name));
  }
  return match;
}

class ExamService {
  static async createExam(userId, payload) {
    const exam = await prisma.exam.create({
      data: {
        userId,
        name: payload.name,
        description: payload.description ?? null,
        examDate: payload.examDate ? new Date(payload.examDate) : null,
        availableHoursPerDay: payload.availableHoursPerDay ?? null,
        metadata: payload.metadata ?? undefined,
      },
    });

    if (payload.subjects && payload.subjects.length > 0) {
      return ExamService.replaceSyllabus(userId, exam.id, payload.subjects);
    }

    return prisma.exam.findUnique({ where: { id: exam.id }, include: syllabusInclude });
  }

  static async listExams(userId) {
    return prisma.exam.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { subjects: true } } },
    });
  }

  static async getExamById(userId, examId) {
    return prisma.exam.findFirst({
      where: { id: examId, userId },
      include: syllabusInclude,
    });
  }

  static async updateExam(userId, examId, payload) {
    const existing = await prisma.exam.findFirst({ where: { id: examId, userId } });
    if (!existing) {
      throw new AppError('Exam not found', 404);
    }

    return prisma.exam.update({
      where: { id: examId },
      data: {
        name: payload.name ?? undefined,
        description: payload.description === undefined ? undefined : payload.description,
        examDate:
          payload.examDate === undefined ? undefined : payload.examDate ? new Date(payload.examDate) : null,
        availableHoursPerDay: payload.availableHoursPerDay === undefined ? undefined : payload.availableHoursPerDay,
        metadata: payload.metadata === undefined ? undefined : payload.metadata,
      },
      include: syllabusInclude,
    });
  }

  static async deleteExam(userId, examId) {
    const existing = await prisma.exam.findFirst({ where: { id: examId, userId } });
    if (!existing) {
      throw new AppError('Exam not found', 404);
    }
    // Subjects/Topics/Subtopics cascade via the FK ON DELETE CASCADE.
    await prisma.exam.delete({ where: { id: examId } });
  }

  /**
   * Reconciles an exam's syllabus tree against a submitted (sub)tree.
   *
   * Nodes with an `id` matching an existing node are updated in place, ids
   * without a match (or missing entirely) are created fresh, and any
   * existing node not present in the payload is deleted (cascading its
   * children). Matching is always scoped to what already belongs to this
   * exam, so a client cannot use someone else's node id to hijack it.
   */
  static async replaceSyllabus(userId, examId, subjectsPayload) {
    assertNoDuplicateNames(subjectsPayload);

    try {
      return await prisma.$transaction(
        async (tx) => {
          const exam = await tx.exam.findFirst({ where: { id: examId, userId } });
          if (!exam) {
            throw new AppError('Exam not found', 404);
          }

          const existingSubjects = await tx.subject.findMany({
            where: { examId },
            include: { topics: { include: { subtopics: true } } },
          });
          const existingSubjectById = new Map(existingSubjects.map((s) => [s.id, s]));
          const existingSubjectByName = new Map(existingSubjects.map((s) => [normalizeName(s.name), s]));
          const keepSubjectIds = new Set();

          for (let i = 0; i < subjectsPayload.length; i++) {
            const subjectInput = subjectsPayload[i];
            const existingSubject = takeMatch(existingSubjectById, existingSubjectByName, subjectInput);

            const subject = existingSubject
              ? await tx.subject.update({
                  where: { id: existingSubject.id },
                  data: { name: subjectInput.name, description: subjectInput.description ?? null, orderIndex: i },
                })
              : await tx.subject.create({
                  data: {
                    examId,
                    userId,
                    name: subjectInput.name,
                    description: subjectInput.description ?? null,
                    orderIndex: i,
                  },
                });

            keepSubjectIds.add(subject.id);

            const existingTopics = existingSubject ? existingSubject.topics : [];
            const existingTopicById = new Map(existingTopics.map((t) => [t.id, t]));
            const existingTopicByName = new Map(existingTopics.map((t) => [normalizeName(t.name), t]));
            const keepTopicIds = new Set();
            const topicsInput = subjectInput.topics || [];

            for (let j = 0; j < topicsInput.length; j++) {
              const topicInput = topicsInput[j];
              const existingTopic = takeMatch(existingTopicById, existingTopicByName, topicInput);

              const topic = existingTopic
                ? await tx.topic.update({
                    where: { id: existingTopic.id },
                    data: { name: topicInput.name, description: topicInput.description ?? null, orderIndex: j },
                  })
                : await tx.topic.create({
                    data: {
                      subjectId: subject.id,
                      name: topicInput.name,
                      description: topicInput.description ?? null,
                      orderIndex: j,
                    },
                  });

              keepTopicIds.add(topic.id);

              const existingSubtopics = existingTopic ? existingTopic.subtopics : [];
              const existingSubtopicById = new Map(existingSubtopics.map((st) => [st.id, st]));
              const existingSubtopicByName = new Map(existingSubtopics.map((st) => [normalizeName(st.name), st]));
              const keepSubtopicIds = new Set();
              const subtopicsInput = topicInput.subtopics || [];

              for (let k = 0; k < subtopicsInput.length; k++) {
                const subtopicInput = subtopicsInput[k];
                const existingSubtopic = takeMatch(existingSubtopicById, existingSubtopicByName, subtopicInput);

                const subtopic = existingSubtopic
                  ? await tx.subtopic.update({
                      where: { id: existingSubtopic.id },
                      data: {
                        name: subtopicInput.name,
                        description: subtopicInput.description ?? null,
                        orderIndex: k,
                      },
                    })
                  : await tx.subtopic.create({
                      data: {
                        topicId: topic.id,
                        name: subtopicInput.name,
                        description: subtopicInput.description ?? null,
                        orderIndex: k,
                      },
                    });

                keepSubtopicIds.add(subtopic.id);
              }

              const subtopicsToDelete = existingSubtopics
                .filter((st) => !keepSubtopicIds.has(st.id))
                .map((st) => st.id);
              if (subtopicsToDelete.length > 0) {
                await tx.subtopic.deleteMany({ where: { id: { in: subtopicsToDelete } } });
              }
            }

            const topicsToDelete = existingTopics.filter((t) => !keepTopicIds.has(t.id)).map((t) => t.id);
            if (topicsToDelete.length > 0) {
              await tx.topic.deleteMany({ where: { id: { in: topicsToDelete } } });
            }
          }

          const subjectsToDelete = existingSubjects.filter((s) => !keepSubjectIds.has(s.id)).map((s) => s.id);
          if (subjectsToDelete.length > 0) {
            await tx.subject.deleteMany({ where: { id: { in: subjectsToDelete } } });
          }

          return tx.exam.findUnique({ where: { id: examId }, include: syllabusInclude });
        },
        // A syllabus tree can be dozens of nodes, each its own round trip to
        // a remote pooled Postgres instance — the 5s interactive-transaction
        // default was getting exceeded on larger (e.g. AI-extracted) trees.
        { timeout: 20000, maxWait: 10000 }
      );
    } catch (error) {
      if (error.code === 'P2002') {
        throw new AppError('Duplicate subject, topic, or subtopic name at the same level', 409);
      }
      throw error;
    }
  }
}

module.exports = ExamService;
