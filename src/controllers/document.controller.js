const path = require('path');
const fs = require('fs');
const prisma = require('../config/db');
const DocumentProcessingService = require('../ai/services/documentProcessing.service');

const uploadDocument = async (req, res, next) => {
  try {
    if (!req.file) {
      res.status(400);
      throw new Error('Please upload a file');
    }

    const { title } = req.body;
    if (!title) {
      // If we need a fallback title, we can use the original file name, but let's enforce it
      res.status(400);
      throw new Error('Please provide a title for the document');
    }

    const document = await prisma.document.create({
      data: {
        userId: req.user.id,
        title,
        fileName: req.file.originalname,
        filePath: req.file.path,
        fileType: req.file.mimetype,
        fileSize: req.file.size,
        processingStatus: 'UPLOADED',
      },
    });

    // Start processing in the background (synchronously starting, but not blocking response)
    DocumentProcessingService.processDocument(document.id).catch(err => {
      console.error('Background processing failed:', err);
    });

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
    const documents = await prisma.document.findMany({
      where: { userId: req.user.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        fileName: true,
        fileSize: true,
        processingStatus: true,
        createdAt: true,
        updatedAt: true,
      },
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
      where: { id }
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

module.exports = {
  uploadDocument,
  getDocuments,
  getDocumentById,
  deleteDocument,
  getDocumentStatus,
};
