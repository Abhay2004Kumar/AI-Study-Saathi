const QuizService = require('../ai/services/quiz.service');

const generateQuiz = async (req, res, next) => {
  try {
    const { subject, topic, numberOfQuestions, difficulty } = req.body;

    if (!subject || !topic) {
      return res.status(400).json({ success: false, error: 'Subject and topic are required' });
    }

    const quiz = await QuizService.generateQuiz(
      req.user.id,
      subject,
      topic,
      numberOfQuestions,
      difficulty
    );

    res.status(200).json({
      success: true,
      data: quiz
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  generateQuiz
};
