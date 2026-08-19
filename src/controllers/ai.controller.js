const RAGService = require('../ai/services/rag.service');

const askQuestion = async (req, res, next) => {
  try {
    const { question } = req.body;

    if (!question) {
      res.status(400);
      throw new Error('Please provide a question');
    }

    // Pass the user's ID to ensure they only query their own documents
    const result = await RAGService.askQuestion(req.user.id, question);

    res.json({
      success: true,
      data: {
        answer: result.answer,
        sources: result.sources
      },
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  askQuestion,
};
