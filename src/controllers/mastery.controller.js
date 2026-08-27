const prisma = require('../config/db');
const MasteryService = require('../services/mastery.service');

const getTopicMastery = async (req, res, next) => {
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

    const mastery = await MasteryService.getTopicMastery(req.user.id, topicId);
    res.json({ success: true, data: { topic: { id: topic.id, name: topic.name }, mastery } });
  } catch (error) {
    next(error);
  }
};

// The "weakness" view: every topic under this exam, weakest-first, so the
// student (and eventually the Phase 9 planner) can see at a glance where to
// spend time — not just per-topic in isolation.
const getExamMastery = async (req, res, next) => {
  try {
    const exam = await prisma.exam.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!exam) {
      res.status(404);
      throw new Error('Exam not found');
    }

    const data = await MasteryService.getExamMastery(req.user.id, exam.id);
    res.json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

module.exports = { getTopicMastery, getExamMastery };
