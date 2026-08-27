const prisma = require('../config/db');
const PyqIntelligenceService = require('../ai/services/pyqIntelligence.service');

// (Re)generates a PYQ document's question-level topic mappings. Synchronous,
// like Phase 5's map-topics — an explicit, user-initiated action with its
// own loading state on the frontend.
const analyzePyqDocument = async (req, res, next) => {
  try {
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!document) {
      res.status(404);
      throw new Error('Document not found');
    }
    if (!document.examId) {
      res.status(400);
      throw new Error('Link this document to an exam before analyzing its questions');
    }

    const result = await PyqIntelligenceService.run(document.id);

    if (result === null) {
      res.status(400);
      throw new Error(
        'Nothing to analyze — this needs to be a PYQ resource with extracted questions and an exam that has a syllabus'
      );
    }

    const stored = await prisma.pyqQuestion.findMany({
      where: { documentId: document.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, data: stored });
  } catch (error) {
    next(error);
  }
};

const getDocumentQuestions = async (req, res, next) => {
  try {
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!document) {
      res.status(404);
      throw new Error('Document not found');
    }

    const questions = await prisma.pyqQuestion.findMany({
      where: { documentId: document.id },
      orderBy: { createdAt: 'asc' },
    });

    res.json({ success: true, data: questions });
  } catch (error) {
    next(error);
  }
};

// The Phase 6 "open a topic and see its PYQ intelligence" view: the actual
// mapped questions plus the deterministic historical-importance score.
const getTopicPyqAnalysis = async (req, res, next) => {
  try {
    const { id: examId, topicId } = req.params;

    const exam = await prisma.exam.findFirst({ where: { id: examId, userId: req.user.id } });
    if (!exam) {
      res.status(404);
      throw new Error('Exam not found');
    }

    const topic = await prisma.topic.findFirst({ where: { id: topicId, subject: { examId } } });
    if (!topic) {
      res.status(404);
      throw new Error('Topic not found in this exam');
    }

    const questions = await prisma.pyqQuestion.findMany({
      where: { topicId, status: { not: 'REJECTED' }, document: { userId: req.user.id } },
      include: { document: { select: { id: true, title: true } }, subtopic: { select: { id: true, name: true } } },
      orderBy: [{ year: 'desc' }, { createdAt: 'asc' }],
    });

    const frequency = await PyqIntelligenceService.getTopicFrequency(topicId);

    res.json({
      success: true,
      data: {
        topic: { id: topic.id, name: topic.name },
        frequency,
        questions: questions.map((q) => ({
          id: q.id,
          questionText: q.questionText,
          options: q.options,
          correctAnswer: q.correctAnswer,
          year: q.year,
          confidence: q.confidence,
          status: q.status,
          subtopic: q.subtopic,
          document: q.document,
        })),
      },
    });
  } catch (error) {
    next(error);
  }
};

const QUESTION_STATUSES = ['CONFIRMED', 'REJECTED', 'PENDING_REVIEW'];

// Same review mechanism as Phase 5's mapping confirm/reject, applied to an
// individual question's topic assignment.
const updateQuestionStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status || !QUESTION_STATUSES.includes(status)) {
      res.status(400);
      throw new Error(`Status must be one of: ${QUESTION_STATUSES.join(', ')}`);
    }

    const question = await prisma.pyqQuestion.findFirst({
      where: { id: req.params.questionId, document: { userId: req.user.id } },
    });
    if (!question) {
      res.status(404);
      throw new Error('Question not found');
    }

    const updated = await prisma.pyqQuestion.update({
      where: { id: question.id },
      data: { status },
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  analyzePyqDocument,
  getDocumentQuestions,
  getTopicPyqAnalysis,
  updateQuestionStatus,
};
