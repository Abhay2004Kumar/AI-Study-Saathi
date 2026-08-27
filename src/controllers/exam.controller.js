const fs = require('fs');
const ExamService = require('../services/exam.service');
const SyllabusExtractionService = require('../ai/services/syllabusExtraction.service');
const { loadDocumentAsLangchainDocs } = require('../ai/utils/documentLoader');

const createExam = async (req, res, next) => {
  try {
    const exam = await ExamService.createExam(req.user.id, req.body);
    res.status(201).json({ success: true, data: exam });
  } catch (error) {
    next(error);
  }
};

const listExams = async (req, res, next) => {
  try {
    const exams = await ExamService.listExams(req.user.id);
    res.json({ success: true, data: exams });
  } catch (error) {
    next(error);
  }
};

const getExam = async (req, res, next) => {
  try {
    const exam = await ExamService.getExamById(req.user.id, req.params.id);
    if (!exam) {
      return res.status(404).json({ success: false, message: 'Exam not found' });
    }
    res.json({ success: true, data: exam });
  } catch (error) {
    next(error);
  }
};

const updateExam = async (req, res, next) => {
  try {
    const exam = await ExamService.updateExam(req.user.id, req.params.id, req.body);
    res.json({ success: true, data: exam });
  } catch (error) {
    next(error);
  }
};

const deleteExam = async (req, res, next) => {
  try {
    await ExamService.deleteExam(req.user.id, req.params.id);
    res.json({ success: true, message: 'Exam deleted successfully' });
  } catch (error) {
    next(error);
  }
};

const replaceSyllabus = async (req, res, next) => {
  try {
    const exam = await ExamService.replaceSyllabus(req.user.id, req.params.id, req.body.subjects);
    res.json({ success: true, data: exam });
  } catch (error) {
    next(error);
  }
};

// Accepts either raw pasted text (JSON body: { text }) or an uploaded
// PDF/TXT/MD file (multipart field: file). Returns a suggested syllabus tree
// without persisting anything — the client re-submits (possibly edited)
// through createExam / replaceSyllabus to actually save it.
const extractSyllabus = async (req, res, next) => {
  try {
    let rawText = req.body.text;

    if (req.file) {
      const docs = await loadDocumentAsLangchainDocs(req.file.path, req.file.mimetype, req.file.originalname);
      rawText = docs.map((d) => d.pageContent).join('\n\n');
      fs.unlink(req.file.path, (err) => {
        if (err) console.error('Failed to clean up temp extraction upload:', err);
      });
    }

    if (!rawText || !rawText.trim()) {
      return res
        .status(400)
        .json({ success: false, message: 'Provide syllabus text or upload a file to extract from' });
    }

    const structure = await SyllabusExtractionService.extractFromText(rawText);
    res.json({ success: true, data: structure });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createExam,
  listExams,
  getExam,
  updateExam,
  deleteExam,
  replaceSyllabus,
  extractSyllabus,
};
