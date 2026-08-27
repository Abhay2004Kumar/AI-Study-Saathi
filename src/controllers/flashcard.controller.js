const prisma = require('../config/db');
const FlashcardService = require('../ai/services/flashcard.service');
const FlashcardReviewService = require('../services/flashcardReview.service');
const { GRADE_QUALITY } = require('../services/spacedRepetition.service');

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

// Generates and adds new flashcards to a topic's deck — additive, not a
// replace, so cards already partway through a repetition schedule are
// never disturbed by generating more.
const generateTopicFlashcards = async (req, res, next) => {
  try {
    const { id: examId, topicId } = req.params;
    const { numberOfCards, subtopicId } = req.body || {};

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

    const cards = await FlashcardService.generateFlashcards({
      userId: req.user.id,
      examId,
      subjectId: owned.topic.subjectId,
      topicId,
      topicName: owned.topic.name,
      subtopicId: subtopicId || null,
      subtopicName,
      numberOfCards,
    });

    if (cards === null) {
      res.status(400);
      throw new Error(
        'Not enough mapped material for this topic to generate flashcards yet — upload or map some notes first'
      );
    }

    res.status(201).json({ success: true, data: cards });
  } catch (error) {
    next(error);
  }
};

const listTopicFlashcards = async (req, res, next) => {
  try {
    const { id: examId, topicId } = req.params;
    const owned = await findOwnedTopic(examId, topicId, req.user.id);
    if (owned.error) {
      res.status(404);
      throw new Error(owned.error);
    }

    const cards = await FlashcardReviewService.getTopicCards(req.user.id, topicId);
    res.json({ success: true, data: cards });
  } catch (error) {
    next(error);
  }
};

// The Phase 10 "smart revision" surface: every card across the exam that's
// due for review right now, soonest-due first.
const getDueFlashcards = async (req, res, next) => {
  try {
    const exam = await prisma.exam.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!exam) {
      res.status(404);
      throw new Error('Exam not found');
    }

    const limit = req.query.limit ? Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50)) : 50;
    const cards = await FlashcardReviewService.getDueCards(req.user.id, exam.id, { limit });
    res.json({ success: true, data: cards });
  } catch (error) {
    next(error);
  }
};

// Grades a review (deterministic SM-2, no AI) and returns the card with its
// next due date.
const reviewFlashcard = async (req, res, next) => {
  try {
    const { grade } = req.body || {};
    if (!grade || !(grade in GRADE_QUALITY)) {
      res.status(400);
      throw new Error(`grade must be one of: ${Object.keys(GRADE_QUALITY).join(', ')}`);
    }

    const card = await FlashcardReviewService.review(req.user.id, req.params.id, grade);
    if (!card) {
      res.status(404);
      throw new Error('Flashcard not found');
    }

    res.json({ success: true, data: card });
  } catch (error) {
    next(error);
  }
};

module.exports = { generateTopicFlashcards, listTopicFlashcards, getDueFlashcards, reviewFlashcard };
