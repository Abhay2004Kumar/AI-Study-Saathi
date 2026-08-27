const express = require('express');
const router = express.Router();
const { updateMappingStatus } = require('../controllers/mapping.controller');
const { protect } = require('../middleware/auth.middleware');

router.use(protect);

// The Phase 5 review action: confirm or reject a resource-topic mapping,
// most importantly the AI-generated ones sitting at PENDING_REVIEW.
router.patch('/:mappingId', updateMappingStatus);

module.exports = router;
