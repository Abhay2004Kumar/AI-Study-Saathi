const prisma = require('../config/db');
const { applyReview } = require('./spacedRepetition.service');

// Persistence/orchestration around the pure SM-2 function above — no AI
// here either, same split as studyPlan.service.js wrapping
// studyPlanning.service.js.
class FlashcardReviewService {
  static async getDueCards(userId, examId, { limit = 50 } = {}) {
    return prisma.flashcard.findMany({
      where: { userId, dueAt: { lte: new Date() }, topic: { subject: { examId } } },
      orderBy: { dueAt: 'asc' },
      take: limit,
    });
  }

  static async getTopicCards(userId, topicId) {
    return prisma.flashcard.findMany({ where: { userId, topicId }, orderBy: { createdAt: 'asc' } });
  }

  static async review(userId, cardId, grade) {
    const card = await prisma.flashcard.findFirst({ where: { id: cardId, userId } });
    if (!card) return null;

    const updated = applyReview(card, grade, new Date());
    return prisma.flashcard.update({ where: { id: card.id }, data: updated });
  }
}

module.exports = FlashcardReviewService;
