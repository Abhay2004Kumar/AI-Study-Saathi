const prisma = require('../config/db');
const StudyPlanService = require('../services/studyPlan.service');

const ERROR_MESSAGES = {
  NOT_FOUND: { status: 404, message: 'Exam not found' },
  MISSING_EXAM_DATE: { status: 400, message: 'Set an exam date before generating a study plan' },
  MISSING_HOURS_PER_DAY: { status: 400, message: 'Set your available study hours per day before generating a study plan' },
  EXAM_DATE_PASSED: { status: 400, message: 'This exam date has already passed' },
  NO_TOPICS: { status: 400, message: 'Add a syllabus with topics before generating a study plan' },
};

const generateStudyPlan = async (req, res, next) => {
  try {
    const result = await StudyPlanService.generate(req.user.id, req.params.id);
    if (result.error) {
      const { status, message } = ERROR_MESSAGES[result.error];
      res.status(status);
      throw new Error(message);
    }

    res.status(201).json({ success: true, data: { plan: result.plan, skippedTopicIds: result.skippedTopicIds } });
  } catch (error) {
    next(error);
  }
};

const getStudyPlan = async (req, res, next) => {
  try {
    // Distinguish "not your exam" (404) from "your exam, no plan generated
    // yet" (200, data: null) — the service alone can't tell those apart.
    const exam = await prisma.exam.findFirst({ where: { id: req.params.id, userId: req.user.id } });
    if (!exam) {
      res.status(404);
      throw new Error('Exam not found');
    }

    const plan = await StudyPlanService.getActivePlan(req.user.id, req.params.id);
    res.json({ success: true, data: plan });
  } catch (error) {
    next(error);
  }
};

const updateSessionCompletion = async (req, res, next) => {
  try {
    const { completed } = req.body || {};
    if (typeof completed !== 'boolean') {
      res.status(400);
      throw new Error('completed must be a boolean');
    }

    const session = await StudyPlanService.setSessionCompletion(req.user.id, req.params.sessionId, completed);
    if (!session) {
      res.status(404);
      throw new Error('Study plan session not found');
    }

    res.json({ success: true, data: session });
  } catch (error) {
    next(error);
  }
};

module.exports = { generateStudyPlan, getStudyPlan, updateSessionCompletion };
