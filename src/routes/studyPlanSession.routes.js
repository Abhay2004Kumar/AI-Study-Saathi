const express = require('express');
const { updateSessionCompletion } = require('../controllers/studyPlan.controller');
const { protect } = require('../middleware/auth.middleware');

const router = express.Router();

router.use(protect);

router.patch('/:sessionId', updateSessionCompletion);

module.exports = router;
