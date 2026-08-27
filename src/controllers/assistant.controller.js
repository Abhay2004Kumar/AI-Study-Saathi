const prisma = require('../config/db');
const StudyAssistantService = require('../ai/services/studyAssistant.service');

const getAssistantSession = async (req, res, next) => {
  try {
    const exam = await prisma.exam.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!exam) {
      res.status(404);
      throw new Error('Exam not found');
    }

    const session = await StudyAssistantService.getSession(req.user.id, exam.id);
    res.json({ success: true, data: session });
  } catch (error) {
    next(error);
  }
};

const sendAssistantMessage = async (req, res, next) => {
  try {
    const { message } = req.body || {};
    if (!message || !message.trim()) {
      res.status(400);
      throw new Error('message is required');
    }

    const result = await StudyAssistantService.sendMessage(req.user.id, req.params.id, message.trim());
    if (!result) {
      res.status(404);
      throw new Error('Exam not found');
    }

    res.status(201).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

module.exports = { getAssistantSession, sendAssistantMessage };
