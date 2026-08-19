const TutorService = require('../ai/services/tutor.service');

const askTutor = async (req, res, next) => {
  try {
    const { question } = req.body;
    
    if (!question) {
      return res.status(400).json({ success: false, error: 'Question is required' });
    }

    const result = await TutorService.askTutor(req.user.id, question);

    res.status(200).json({
      success: true,
      data: result
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  askTutor
};
