const express = require('express');
const { startSession, respondToTutor, getSession } = require('../controllers/tutoring.controller');
const { protect } = require('../middleware/auth.middleware');

const router = express.Router();

// Start a new tutoring session
router.post('/session/start', protect, startSession);

// Submit student's answer and get next AI response
router.post('/session/:id/respond', protect, respondToTutor);

// View session details and full conversation history
router.get('/session/:id', protect, getSession);

module.exports = router;
