const TutoringService = require('../ai/services/tutoring.service');

const startSession = async (req, res, next) => {
  try {
    const { subject, topic } = req.body;
    if (!subject || !topic) {
      return res.status(400).json({ success: false, error: 'Subject and topic are required' });
    }
    const result = await TutoringService.startSession(req.user.id, subject, topic);
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const respondToTutor = async (req, res, next) => {
  try {
    const { id: sessionId } = req.params;
    const { answer } = req.body;
    if (!answer) {
      return res.status(400).json({ success: false, error: 'Answer is required' });
    }
    const result = await TutoringService.respond(sessionId, answer);
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const getSession = async (req, res, next) => {
  try {
    const { id: sessionId } = req.params;
    const session = await TutoringService.getSession(sessionId, req.user.id);
    res.status(200).json({ success: true, data: session });
  } catch (error) {
    next(error);
  }
};

module.exports = { startSession, respondToTutor, getSession };
