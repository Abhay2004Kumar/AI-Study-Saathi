const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence } = require('@langchain/core/runnables');
const { z } = require('zod');
const prisma = require('../../config/db');
const config = require('../../config/env');
const { withRetry } = require('../utils/withRetry');
const { isRecordGoneError } = require('../../utils/prismaErrors');

// AI-reported mappings below this land as PENDING_REVIEW instead of
// CONFIRMED — a low-confidence guess should never silently misdirect a
// student's revision without a human confirming it first.
const CONFIDENCE_THRESHOLD = 0.6;

const MAX_CONTENT_CHARS = 20000;

const mappingSchema = z.object({
  mappings: z
    .array(
      z.object({
        topicName: z.string().describe('The exact name of a topic or subtopic from the provided syllabus list'),
        startPage: z.number().int().optional().describe('First page this topic is covered on, if the material has pages'),
        endPage: z.number().int().optional().describe('Last page this topic is covered on, if the material has pages'),
        confidence: z.number().min(0).max(1).describe('Confidence that this mapping is correct'),
      })
    )
    .describe("Mappings from this resource's content to syllabus topics — an empty array if nothing matches"),
});

function normalizeName(name) {
  return (name || '').trim().toLowerCase();
}

/**
 * Builds the flat "choose exactly one of these names" catalog handed to the
 * model, plus a name -> {topicId, subtopicId} lookup used to validate its
 * response afterward. Pure and synchronous — no I/O.
 *
 * @param {Array} subjects - exam.subjects, each with nested topics -> subtopics
 * @returns {{ catalogText: string, targetByName: Map }}
 */
function buildCatalog(subjects) {
  const catalogLines = [];
  const targetByName = new Map();

  for (const subject of subjects) {
    for (const topic of subject.topics) {
      catalogLines.push(`Topic: "${topic.name}" (in Subject "${subject.name}")`);
      targetByName.set(normalizeName(topic.name), { topicId: topic.id, subtopicId: null });
      for (const subtopic of topic.subtopics) {
        catalogLines.push(`Subtopic: "${subtopic.name}" (under Topic "${topic.name}")`);
        targetByName.set(normalizeName(subtopic.name), { topicId: topic.id, subtopicId: subtopic.id });
      }
    }
  }

  return { catalogText: catalogLines.join('\n'), targetByName };
}

/**
 * Validates a raw AI mapping response against the real syllabus catalog and
 * turns it into DB-ready rows. Never trusts the model outright: a
 * `topicName` that isn't an exact (case-insensitive) match for something in
 * `targetByName` is dropped rather than guessed at, and anything below
 * CONFIDENCE_THRESHOLD is downgraded to PENDING_REVIEW instead of being
 * auto-confirmed. Pure and synchronous, so this is unit-testable without a
 * live LLM call.
 *
 * @param {Array} rawMappings - the model's { topicName, startPage?, endPage?, confidence } items
 * @param {Map} targetByName - from buildCatalog()
 * @param {string} documentId
 * @returns {Array} rows ready for resourceTopicMapping.createMany
 */
function validateMappings(rawMappings, targetByName, documentId) {
  return (rawMappings || [])
    .map((m) => {
      const target = targetByName.get(normalizeName(m.topicName));
      if (!target) return null; // not a real syllabus node — invalid AI output, dropped

      const confidence = typeof m.confidence === 'number' ? m.confidence : 0;
      return {
        documentId,
        topicId: target.topicId,
        subtopicId: target.subtopicId,
        startPage: Number.isInteger(m.startPage) ? m.startPage : null,
        endPage: Number.isInteger(m.endPage) ? m.endPage : null,
        confidence,
        status: confidence >= CONFIDENCE_THRESHOLD ? 'CONFIRMED' : 'PENDING_REVIEW',
      };
    })
    .filter(Boolean);
}

class TopicMappingService {
  /**
   * Maps a document's content onto its exam's syllabus tree (Topic/Subtopic
   * + page range), replacing any previous mappings for that document.
   * Returns null when there's nothing to map against (no exam linked, no
   * syllabus yet, or no chunked content), and [] when mapping ran but found
   * no genuine matches.
   *
   * @param {string} documentId
   * @returns {Promise<Array|null>}
   */
  static async run(documentId) {
    const document = await prisma.document.findUnique({ where: { id: documentId } });
    if (!document || !document.examId) return null;

    const exam = await prisma.exam.findUnique({
      where: { id: document.examId },
      include: { subjects: { include: { topics: { include: { subtopics: true } } } } },
    });
    if (!exam || exam.subjects.length === 0) return null;

    const chunks = await prisma.documentChunk.findMany({
      where: { documentId },
      orderBy: { chunkIndex: 'asc' },
    });
    if (chunks.length === 0) return null;

    const { catalogText, targetByName } = buildCatalog(exam.subjects);
    if (targetByName.size === 0) return null;

    const content = chunks
      .map((c) => {
        const page = c.metadata?.loc?.pageNumber;
        return `${page ? `[Page ${page}] ` : ''}${c.content}`;
      })
      .join('\n\n')
      .slice(0, MAX_CONTENT_CHARS);

    const result = await TopicMappingService._generateMappings(catalogText, content);
    if (!result) return null;

    const validMappings = validateMappings(result.mappings, targetByName, documentId);

    try {
      // Replace wholesale — re-running mapping (e.g. via retry, or after the
      // syllabus changes) shouldn't accumulate stale duplicate rows.
      await prisma.$transaction([
        prisma.resourceTopicMapping.deleteMany({ where: { documentId } }),
        ...(validMappings.length > 0 ? [prisma.resourceTopicMapping.createMany({ data: validMappings })] : []),
      ]);
    } catch (error) {
      if (isRecordGoneError(error)) return null;
      throw error;
    }

    return validMappings;
  }

  static async _generateMappings(catalog, content) {
    const parser = StructuredOutputParser.fromZodSchema(mappingSchema);
    const llm = new ChatGoogleGenerativeAI({
      apiKey: config.gemini.apiKey,
      model: 'gemini-3.5-flash-lite',
      temperature: 0,
    });
    const prompt = PromptTemplate.fromTemplate(`
You are mapping a student's study resource onto their course syllabus.

SYLLABUS TOPICS (choose ONLY from this list, using the exact name given):
{catalog}

RESOURCE CONTENT (page-labeled where available):
{content}

INSTRUCTIONS:
- For each syllabus topic or subtopic actually covered in the content, report the page range it's covered on (only if pages are labeled above) and your confidence.
- Use the exact name as given in the syllabus list — do not paraphrase, translate, or invent a new name.
- Skip any topic not genuinely covered in this content.
- Do NOT output markdown code blocks. Just output raw JSON.

{format_instructions}
`);
    const chain = RunnableSequence.from([prompt, llm, parser]);

    try {
      return await withRetry(() =>
        chain.invoke({ catalog, content, format_instructions: parser.getFormatInstructions() })
      );
    } catch (error) {
      console.error('Topic mapping generation failed:', error);
      return null;
    }
  }
}

module.exports = TopicMappingService;
module.exports.buildCatalog = buildCatalog;
module.exports.validateMappings = validateMappings;
module.exports.CONFIDENCE_THRESHOLD = CONFIDENCE_THRESHOLD;
