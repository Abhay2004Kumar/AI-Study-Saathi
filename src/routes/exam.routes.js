const express = require('express');
const router = express.Router();
const {
  createExam,
  listExams,
  getExam,
  updateExam,
  deleteExam,
  replaceSyllabus,
  extractSyllabus,
} = require('../controllers/exam.controller');
const { getTopicResources } = require('../controllers/mapping.controller');
const { getTopicPyqAnalysis } = require('../controllers/pyq.controller');
const { generateTopicQuiz, listTopicQuizzes } = require('../controllers/quiz.controller');
const { getTopicMastery, getExamMastery } = require('../controllers/mastery.controller');
const { generateStudyPlan, getStudyPlan } = require('../controllers/studyPlan.controller');
const { generateTopicFlashcards, listTopicFlashcards, getDueFlashcards } = require('../controllers/flashcard.controller');
const { getAssistantSession, sendAssistantMessage } = require('../controllers/assistant.controller');
const { protect } = require('../middleware/auth.middleware');
const { uploadMiddleware } = require('../middleware/upload.middleware');
const {
  validateCreateExam,
  validateUpdateExam,
  validateReplaceSyllabus,
  validateExtractSyllabus,
} = require('../validators/exam.validator');

// All exam routes require authentication
router.use(protect);

router.post('/syllabus/extract', uploadMiddleware, validateExtractSyllabus, extractSyllabus);

router.route('/')
  .post(validateCreateExam, createExam)
  .get(listExams);

router.route('/:id')
  .get(getExam)
  .patch(validateUpdateExam, updateExam)
  .delete(deleteExam);

router.put('/:id/syllabus', validateReplaceSyllabus, replaceSyllabus);

router.get('/:id/topics/:topicId/resources', getTopicResources);
router.get('/:id/topics/:topicId/pyq-analysis', getTopicPyqAnalysis);
router.route('/:id/topics/:topicId/quizzes')
  .get(listTopicQuizzes)
  .post(generateTopicQuiz);
router.get('/:id/mastery', getExamMastery);
router.get('/:id/topics/:topicId/mastery', getTopicMastery);
router.route('/:id/study-plan')
  .get(getStudyPlan)
  .post(generateStudyPlan);
router.route('/:id/topics/:topicId/flashcards')
  .get(listTopicFlashcards)
  .post(generateTopicFlashcards);
router.get('/:id/flashcards/due', getDueFlashcards);
router.get('/:id/assistant', getAssistantSession);
router.post('/:id/assistant/message', sendAssistantMessage);

module.exports = router;
