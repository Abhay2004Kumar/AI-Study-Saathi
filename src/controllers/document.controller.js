const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const prisma = require('../config/db');
const DocumentProcessingService = require('../ai/services/documentProcessing.service');

const CATEGORIES = ['SYLLABUS', 'NOTES', 'PYQ', 'GENERAL'];

const documentSelect = {
  id: true,
  title: true,
  fileName: true,
  fileType: true,
  fileSize: true,
  examId: true,
  category: true,
  aiCategory: true,
  classificationConfidence: true,
  pageCount: true,
  processingStatus: true,
  createdAt: true,
  updatedAt: true,
};

function hashFile(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const uploadDocument = async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload a file');
    }

    const { title, examId } = req.body;
    let { category } = req.body;

    if (!title) {
      res.status(400);
      throw new Error('Please provide a title for the document');
    }

    if (category && !CATEGORIES.includes(category)) {
      res.status(400);
      throw new Error(`Invalid category. Must be one of: ${CATEGORIES.join(', ')}`);
    }
    category = category || 'GENERAL';

    if (examId) {
      const exam = await prisma.exam.findFirst({ where: { id: examId, userId: req.user.id } });
      if (!exam) {
        res.status(404);
        throw new Error('Exam not found');
      }
    }

    const fileHash = hashFile(req.file.path);
    const duplicate = await prisma.document.findFirst({
      where: { userId: req.user.id, fileHash },
      select: { id: true, title: true },
    });

    if (duplicate) {
      // Cleanup is handled once, uniformly, by the outer catch below —
      // unlinking here too would just race it and fail with ENOENT.
      res.status(409);
      throw new Error(`This exact file was already uploaded as "${duplicate.title}"`);
    }

    const document = await prisma.document.create({
      data: {
        userId: req.user.id,
        examId: examId || null,
        title,
        fileName: req.file.originalname,
        filePath: req.file.path,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        fileHash,
        category,
        processingStatus: 'UPLOADED',
      },
      select: documentSelect,
    });

    // Start processing in the background (synchronously starting, but not blocking response)
    DocumentProcessingService.processInBackground(document.id);

    res.status(201).json({
      success: true,
      data: document,
    });
  } catch (error) {
    // If DB fails, we should ideally clean up the uploaded file to avoid orphaned files
    if (req.file) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Failed to clean up file after failed DB save:', err);
      });
    }
    next(error);
  }
};

const getDocuments = async (req, res, next) => {
  try {
    const { examId } = req.query;
    const where = { userId: req.user.id };
    if (examId) where.examId = examId;

    const documents = await prisma.document.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      select: documentSelect,
    });

    res.json({
      success: true,
      data: documents,
    });
  } catch (error) {
    next(error);
  }
};

const getDocumentById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const document = await prisma.document.findUnique({
      where: { id },
      include: { extraction: true },
    });

    if (!document) {
      return res.status(404).json({ success: false, error: 'Document not found' });
    }

    if (document.userId !== req.user.id) {
      return res.status(403).json({ success: false, error: 'Not authorized to access this document' });
    }

    res.status(200).json({
      success: true,
      data: document
    });
  } catch (error) {
    next(error);
  }
};

const deleteDocument = async (req, res, next) => {
  try {
    const document = await prisma.document.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      }
    });

    if (!document) {
      res.status(404);
      throw new Error('Document not found');
    }

    // 2. Delete from DB (associated chunks will be deleted due to Cascade)
    await prisma.document.delete({
      where: { id: document.id }
    });

    // 3. Delete from file system
    const absolutePath = path.resolve(__dirname, '../../', document.filePath);
    if (fs.existsSync(absolutePath)) {
      fs.unlinkSync(absolutePath);
    }

    res.json({
      success: true,
      message: 'Document deleted successfully',
    });
  } catch (error) {
    next(error);
  }
};

const getDocumentStatus = async (req, res, next) => {
  try {
    const document = await prisma.document.findFirst({
      where: {
        id: req.params.id,
        userId: req.user.id
      },
      select: {
        id: true,
        processingStatus: true
      }
    });

    if (!document) {
      res.status(404);
      throw new Error('Document not found');
    }

    res.json({
      success: true,
      data: {
        status: document.processingStatus
      }
    });
  } catch (error) {
    next(error);
  }
};

const updateDocument = async (req, res, next) => {
  try {
    const { category } = req.body;

    if (!category) {
      res.status(400);
      throw new Error('Nothing to update — provide a category');
    }
    if (!CATEGORIES.includes(category)) {
      res.status(400);
      throw new Error(`Invalid category. Must be one of: ${CATEGORIES.join(', ')}`);
    }

    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!document) {
      res.status(404);
      throw new Error('Document not found');
    }

    const updated = await prisma.document.update({
      where: { id: document.id },
      data: { category },
      select: documentSelect,
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

const retryDocument = async (req, res, next) => {
  try {
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });

    if (!document) {
      res.status(404);
      throw new Error('Document not found');
    }

    if (document.processingStatus !== 'FAILED') {
      res.status(400);
      throw new Error(`Only failed documents can be retried (current status: ${document.processingStatus})`);
    }

    const updated = await prisma.document.update({
      where: { id: document.id },
      data: { processingStatus: 'UPLOADED' },
      select: documentSelect,
    });

    DocumentProcessingService.processInBackground(document.id);

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  uploadDocument,
  getDocuments,
  getDocumentById,
  updateDocument,
  deleteDocument,
  getDocumentStatus,
  retryDocument,
};
