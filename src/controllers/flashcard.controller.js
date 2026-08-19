const FlashcardService = require('../ai/services/flashcard.service');

const generateFlashcards = async (req, res, next) => {
  try {
    const { subject, topic, numberOfCards } = req.body;

    if (!subject || !topic) {
      return res.status(400).json({ success: false, error: 'Subject and topic are required' });
    }

    const deck = await FlashcardService.generateFlashcards(
      req.user.id,
      subject,
      topic,
      numberOfCards
    );

    res.status(200).json({
      success: true,
      data: deck
    });
  } catch (error) {
    console.error('Flashcard generation error:', error.message);
    next(error);
  }
};

module.exports = { generateFlashcards };
