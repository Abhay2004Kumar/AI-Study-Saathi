const express = require('express');
const { askTutor } = require('../controllers/tutor.controller');
const { protect } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/ask', protect, askTutor);

module.exports = router;
