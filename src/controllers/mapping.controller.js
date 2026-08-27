const prisma = require('../config/db');
const TopicMappingService = require('../ai/services/topicMapping.service');

const mappingSelect = {
  id: true,
  documentId: true,
  topicId: true,
  subtopicId: true,
  startPage: true,
  endPage: true,
  confidence: true,
  status: true,
  createdAt: true,
};

// (Re)generates a document's mappings onto its exam's syllabus. Synchronous
// (not fire-and-forget) since this is always an explicit, user-initiated
// action with its own loading state on the frontend, unlike upload/retry.
const mapDocumentTopics = async (req, res, next) => {
  try {
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!document) {
      res.status(404);
      throw new Error('Document not found');
    }
    if (!document.examId) {
      res.status(400);
      throw new Error('Link this document to an exam before mapping it to topics');
    }

    const result = await TopicMappingService.run(document.id);

    if (result === null) {
      res.status(400);
      throw new Error('This exam has no syllabus yet, or this document has no processed content — nothing to map');
    }

    // The service's own return value has no `id` (createMany doesn't return
    // rows), so re-fetch to get the persisted, addressable mapping records.
    const stored = await prisma.resourceTopicMapping.findMany({
      where: { documentId: document.id },
      select: mappingSelect,
      orderBy: { startPage: 'asc' },
    });

    res.json({ success: true, data: await enrichMappings(stored) });
  } catch (error) {
    next(error);
  }
};

const getDocumentMappings = async (req, res, next) => {
  try {
    const document = await prisma.document.findFirst({
      where: { id: req.params.id, userId: req.user.id },
    });
    if (!document) {
      res.status(404);
      throw new Error('Document not found');
    }

    const mappings = await prisma.resourceTopicMapping.findMany({
      where: { documentId: document.id },
      select: mappingSelect,
      orderBy: { startPage: 'asc' },
    });

    res.json({ success: true, data: await enrichMappings(mappings) });
  } catch (error) {
    next(error);
  }
};

// A user opening a topic should see everything mapped to it: which
// resources cover it, on which pages, split by category (notes vs PYQs) so
// the two are easy to tell apart at a glance. Low-confidence mappings stay
// visible (status: PENDING_REVIEW) rather than hidden — visibility is the
// review mechanism, not a silent filter.
const getTopicResources = async (req, res, next) => {
  try {
    const { id: examId, topicId } = req.params;

    const exam = await prisma.exam.findFirst({ where: { id: examId, userId: req.user.id } });
    if (!exam) {
      res.status(404);
      throw new Error('Exam not found');
    }

    const topic = await prisma.topic.findFirst({
      where: { id: topicId, subject: { examId } },
    });
    if (!topic) {
      res.status(404);
      throw new Error('Topic not found in this exam');
    }

    const mappings = await prisma.resourceTopicMapping.findMany({
      where: {
        topicId,
        document: { userId: req.user.id },
      },
      include: {
        document: { select: { id: true, title: true, category: true, fileName: true, processingStatus: true } },
        subtopic: { select: { id: true, name: true } },
      },
      orderBy: { startPage: 'asc' },
    });

    const shaped = mappings.map((m) => ({
      id: m.id,
      startPage: m.startPage,
      endPage: m.endPage,
      confidence: m.confidence,
      status: m.status,
      subtopic: m.subtopic,
      document: m.document,
    }));

    res.json({
      success: true,
      data: {
        topic: { id: topic.id, name: topic.name },
        notes: shaped.filter((m) => m.document.category === 'NOTES' || m.document.category === 'GENERAL'),
        pyqs: shaped.filter((m) => m.document.category === 'PYQ'),
        syllabus: shaped.filter((m) => m.document.category === 'SYLLABUS'),
      },
    });
  } catch (error) {
    next(error);
  }
};

const MAPPING_STATUSES = ['CONFIRMED', 'REJECTED', 'PENDING_REVIEW'];

// The Phase 5 review mechanism: a human confirms or rejects a low-confidence
// (or any) mapping rather than the app silently trusting the AI's guess.
const updateMappingStatus = async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!status || !MAPPING_STATUSES.includes(status)) {
      res.status(400);
      throw new Error(`Status must be one of: ${MAPPING_STATUSES.join(', ')}`);
    }

    const mapping = await prisma.resourceTopicMapping.findFirst({
      where: { id: req.params.mappingId, document: { userId: req.user.id } },
    });
    if (!mapping) {
      res.status(404);
      throw new Error('Mapping not found');
    }

    const updated = await prisma.resourceTopicMapping.update({
      where: { id: mapping.id },
      data: { status },
      select: mappingSelect,
    });

    res.json({ success: true, data: updated });
  } catch (error) {
    next(error);
  }
};

async function enrichMappings(mappings) {
  if (mappings.length === 0) return [];

  const topicIds = [...new Set(mappings.map((m) => m.topicId))];
  const subtopicIds = [...new Set(mappings.map((m) => m.subtopicId).filter(Boolean))];

  const [topics, subtopics] = await Promise.all([
    prisma.topic.findMany({ where: { id: { in: topicIds } }, select: { id: true, name: true } }),
    subtopicIds.length
      ? prisma.subtopic.findMany({ where: { id: { in: subtopicIds } }, select: { id: true, name: true } })
      : Promise.resolve([]),
  ]);
  const topicById = new Map(topics.map((t) => [t.id, t]));
  const subtopicById = new Map(subtopics.map((s) => [s.id, s]));

  return mappings.map((m) => ({
    ...m,
    topic: topicById.get(m.topicId) || null,
    subtopic: m.subtopicId ? subtopicById.get(m.subtopicId) || null : null,
  }));
}

module.exports = {
  mapDocumentTopics,
  getDocumentMappings,
  getTopicResources,
  updateMappingStatus,
};
