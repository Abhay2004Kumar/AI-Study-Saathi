const express = require('express');
const { reviewFlashcard } = require('../controllers/flashcard.controller');
const { protect } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(protect);

router.post('/:id/review', reviewFlashcard);

module.exports = router;
