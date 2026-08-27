const express = require('express');
const {
  getQuiz,
  submitQuizAttempt,
  listQuizAttempts,
  getQuizAttempt,
} = require('../controllers/quiz.controller');
const { protect } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(protect);

router.get('/:quizId', getQuiz);
router.post('/:quizId/submit', submitQuizAttempt);
router.get('/:quizId/attempts', listQuizAttempts);
router.get('/:quizId/attempts/:attemptId', getQuizAttempt);

module.exports = router;
