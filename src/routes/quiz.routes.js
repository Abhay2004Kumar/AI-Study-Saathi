const express = require('express');
const { generateQuiz } = require('../controllers/quiz.controller');
const { protect } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/generate', protect, generateQuiz);

module.exports = router;
