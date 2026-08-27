const prisma = require('../config/db');
const QuizService = require('../ai/services/quiz.service');

const DIFFICULTIES = ['easy', 'medium', 'hard'];

const quizSummarySelect = {
  id: true,
  title: true,
  difficulty: true,
  topicId: true,
  subtopicId: true,
  sourceDocumentIds: true,
  createdAt: true,
  _count: { select: { questions: true } },
};

// Strips answer-revealing fields so a quiz can be sent to the client before
// it's been attempted, without the correct answers riding along in the
// network payload.
function toTakeableQuestion(q) {
  return { id: q.id, question: q.question, options: q.options, difficulty: q.difficulty };
}

async function findOwnedTopic(examId, topicId, userId) {
  const exam = await prisma.exam.findFirst({ where: { id: examId, userId } });
  if (!exam) return { error: 'Exam not found' };

  const topic = await prisma.topic.findFirst({
    where: { id: topicId, subject: { examId } },
    select: { id: true, name: true, subjectId: true },
  });
  if (!topic) return { error: 'Topic not found in this exam' };

  return { exam, topic };
}

// Generates a new quiz for a topic (optionally narrowed to a subtopic) from
// the student's own mapped resources, and persists it — replacing the old
// free-text, never-saved draft this endpoint used to produce.
const generateTopicQuiz = async (req, res, next) => {
  try {
    const { id: examId, topicId } = req.params;
    const { numberOfQuestions, difficulty = 'medium', subtopicId } = req.body || {};

    if (!DIFFICULTIES.includes(difficulty)) {
      res.status(400);
      throw new Error(`difficulty must be one of: ${DIFFICULTIES.join(', ')}`);
    }

    const owned = await findOwnedTopic(examId, topicId, req.user.id);
    if (owned.error) {
      res.status(404);
      throw new Error(owned.error);
    }

    let subtopicName = null;
    if (subtopicId) {
      const subtopic = await prisma.subtopic.findFirst({ where: { id: subtopicId, topicId } });
      if (!subtopic) {
        res.status(404);
        throw new Error('Subtopic not found under this topic');
      }
      subtopicName = subtopic.name;
    }

    const quiz = await QuizService.generateQuiz({
      userId: req.user.id,
      examId,
      subjectId: owned.topic.subjectId,
      topicId,
      topicName: owned.topic.name,
      subtopicId: subtopicId || null,
      subtopicName,
      numberOfQuestions,
      difficulty,
    });

    if (!quiz) {
      res.status(400);
      throw new Error(
        'Not enough mapped material for this topic to generate a quiz yet — upload or map some notes first'
      );
    }

    res.status(201).json({
      success: true,
      data: {
        id: quiz.id,
        title: quiz.title,
        difficulty: quiz.difficulty,
        topicId: quiz.topicId,
        subtopicId: quiz.subtopicId,
        sourceDocumentIds: quiz.sourceDocumentIds,
        createdAt: quiz.createdAt,
        questions: quiz.questions.map(toTakeableQuestion),
      },
    });
  } catch (error) {
    next(error);
  }
};

const listTopicQuizzes = async (req, res, next) => {
  try {
    const { id: examId, topicId } = req.params;
    const owned = await findOwnedTopic(examId, topicId, req.user.id);
    if (owned.error) {
      res.status(404);
      throw new Error(owned.error);
    }

    const quizzes = await prisma.quiz.findMany({
      where: { topicId, userId: req.user.id },
      select: {
        ...quizSummarySelect,
        attempts: {
          select: { id: true, score: true, completedAt: true },
          orderBy: { completedAt: 'desc' },
          take: 1,
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    res.json({
      success: true,
      data: quizzes.map((q) => ({
        id: q.id,
        title: q.title,
        difficulty: q.difficulty,
        subtopicId: q.subtopicId,
        questionCount: q._count.questions,
        createdAt: q.createdAt,
        lastAttempt: q.attempts[0] || null,
      })),
    });
  } catch (error) {
    next(error);
  }
};

// Fetches a quiz to take — questions only, no answers.
const getQuiz = async (req, res, next) => {
  try {
    const quiz = await prisma.quiz.findFirst({
      where: { id: req.params.quizId, userId: req.user.id },
      include: { questions: true },
    });
    if (!quiz) {
      res.status(404);
      throw new Error('Quiz not found');
    }

    res.json({
      success: true,
      data: {
        id: quiz.id,
        title: quiz.title,
        difficulty: quiz.difficulty,
        topicId: quiz.topicId,
        subtopicId: quiz.subtopicId,
        createdAt: quiz.createdAt,
        questions: quiz.questions.map(toTakeableQuestion),
      },
    });
  } catch (error) {
    next(error);
  }
};

// Grades the submission server-side (deterministic exact-match, never the
// client's own claim of its score) and persists the attempt with a
// per-question breakdown for later review and for Phase 8's mastery engine.
const submitQuizAttempt = async (req, res, next) => {
  try {
    const { answers } = req.body || {};
    if (!Array.isArray(answers)) {
      res.status(400);
      throw new Error('answers must be an array of { questionId, selectedAnswer }');
    }

    const result = await QuizService.submitAttempt(req.params.quizId, req.user.id, answers);
    if (!result) {
      res.status(404);
      throw new Error('Quiz not found');
    }

    const { attempt, quiz } = result;
    const questionById = new Map(quiz.questions.map((q) => [q.id, q]));

    res.status(201).json({
      success: true,
      data: {
        id: attempt.id,
        quizId: quiz.id,
        score: attempt.score,
        correctCount: attempt.correctCount,
        totalQuestions: attempt.totalQuestions,
        completedAt: attempt.completedAt,
        answers: attempt.answers.map((a) => {
          const q = questionById.get(a.questionId);
          return {
            questionId: a.questionId,
            question: q?.question,
            options: q?.options,
            selectedAnswer: a.selectedAnswer,
            correctAnswer: q?.correctAnswer,
            explanation: q?.explanation,
            isCorrect: a.isCorrect,
          };
        }),
      },
    });
  } catch (error) {
    next(error);
  }
};

const listQuizAttempts = async (req, res, next) => {
  try {
    const quiz = await prisma.quiz.findFirst({ where: { id: req.params.quizId, userId: req.user.id } });
    if (!quiz) {
      res.status(404);
      throw new Error('Quiz not found');
    }

    const attempts = await prisma.quizAttempt.findMany({
      where: { quizId: quiz.id },
      select: { id: true, score: true, correctCount: true, totalQuestions: true, startedAt: true, completedAt: true },
      orderBy: { completedAt: 'desc' },
    });

    res.json({ success: true, data: attempts });
  } catch (error) {
    next(error);
  }
};

const getQuizAttempt = async (req, res, next) => {
  try {
    const attempt = await prisma.quizAttempt.findFirst({
      where: { id: req.params.attemptId, quizId: req.params.quizId, userId: req.user.id },
      include: { answers: true },
    });
    if (!attempt) {
      res.status(404);
      throw new Error('Attempt not found');
    }

    const quiz = await prisma.quiz.findFirst({
      where: { id: req.params.quizId },
      include: { questions: true },
    });
    const questionById = new Map((quiz?.questions || []).map((q) => [q.id, q]));

    res.json({
      success: true,
      data: {
        id: attempt.id,
        quizId: attempt.quizId,
        score: attempt.score,
        correctCount: attempt.correctCount,
        totalQuestions: attempt.totalQuestions,
        completedAt: attempt.completedAt,
        answers: attempt.answers.map((a) => {
          const q = questionById.get(a.questionId);
          return {
            questionId: a.questionId,
            question: q?.question,
            options: q?.options,
            selectedAnswer: a.selectedAnswer,
            correctAnswer: q?.correctAnswer,
            explanation: q?.explanation,
            isCorrect: a.isCorrect,
          };
        }),
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  generateTopicQuiz,
  listTopicQuizzes,
  getQuiz,
  submitQuizAttempt,
  listQuizAttempts,
  getQuizAttempt,
};
