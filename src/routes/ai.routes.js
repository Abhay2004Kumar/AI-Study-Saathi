const express = require('express');
const router = express.Router();
const { askQuestion } = require('../controllers/ai.controller');
const { protect } = require('../middleware/auth.middleware');

router.use(protect);

router.post('/ask', askQuestion);

module.exports = router;
