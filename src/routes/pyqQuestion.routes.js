const express = require('express');
const router = express.Router();
const { updateQuestionStatus } = require('../controllers/pyq.controller');
const { protect } = require('../middleware/auth.middleware');

router.use(protect);

// Same review action as /api/mappings/:mappingId, for an individual
// PYQ question's topic assignment.
router.patch('/:questionId', updateQuestionStatus);

module.exports = router;
