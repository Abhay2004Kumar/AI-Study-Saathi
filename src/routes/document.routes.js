const express = require('express');
const router = express.Router();
const {
  uploadDocument,
  getDocuments,
  getDocumentById,
  deleteDocument,
  getDocumentStatus,
} = require('../controllers/document.controller');
const { protect } = require('../middleware/auth.middleware');
const { uploadMiddleware } = require('../middleware/upload.middleware');

// All document routes require authentication
router.use(protect);

router.route('/')
  .post(uploadMiddleware, uploadDocument)
  .get(getDocuments);

router.route('/:id')
  .get(getDocumentById)
  .delete(deleteDocument);

router.route('/:id/status')
  .get(getDocumentStatus);

module.exports = router;
