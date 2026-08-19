const express = require('express');
const { generateFlashcards } = require('../controllers/flashcard.controller');
const { protect } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/generate', protect, generateFlashcards);

module.exports = router;
