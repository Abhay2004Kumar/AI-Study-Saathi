const express = require('express');
const router = express.Router();
const {
  uploadDocument,
  getDocuments,
  getDocumentById,
  updateDocument,
  deleteDocument,
  getDocumentStatus,
  retryDocument,
} = require('../controllers/document.controller');
const { mapDocumentTopics, getDocumentMappings } = require('../controllers/mapping.controller');
const { analyzePyqDocument, getDocumentQuestions } = require('../controllers/pyq.controller');
const { protect } = require('../middleware/auth.middleware');
const { uploadMiddleware } = require('../middleware/upload.middleware');

// All document routes require authentication
router.use(protect);

router.route('/')
  .post(uploadMiddleware, uploadDocument)
  .get(getDocuments);

router.route('/:id')
  .get(getDocumentById)
  .patch(updateDocument)
  .delete(deleteDocument);

router.route('/:id/status')
  .get(getDocumentStatus);

router.route('/:id/retry')
  .post(retryDocument);

router.route('/:id/mappings')
  .get(getDocumentMappings);

router.route('/:id/map-topics')
  .post(mapDocumentTopics);

router.route('/:id/questions')
  .get(getDocumentQuestions);

router.route('/:id/analyze-pyq')
  .post(analyzePyqDocument);

module.exports = router;
