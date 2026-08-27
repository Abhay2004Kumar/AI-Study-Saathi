const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { RunnableSequence } = require('@langchain/core/runnables');
const { z } = require('zod');
const prisma = require('../../config/db');
const config = require('../../config/env');
const { withRetry } = require('../utils/withRetry');
const { isRecordGoneError } = require('../../utils/prismaErrors');
const TopicMappingService = require('./topicMapping.service');
const { computeTopicFrequency } = require('../../services/pyqFrequency.service');

// Same threshold semantics as Phase 5's ResourceTopicMapping: below this, a
// question's topic assignment needs a human to confirm it rather than being
// auto-trusted.
const CONFIDENCE_THRESHOLD = TopicMappingService.CONFIDENCE_THRESHOLD;

const MAX_QUESTIONS_PER_RUN = 60; // bounds a single prompt's size/cost

const mappingSchema = z.object({
  mappings: z
    .array(
      z.object({
        questionLabel: z.string().describe('The label (e.g. "Q1") of the question being mapped'),
        topicName: z.string().describe('The exact name of the single most relevant topic or subtopic from the syllabus list'),
        confidence: z.number().min(0).max(1),
      })
    )
    .describe('One entry per question with a genuine syllabus match — omit questions with no clear match'),
});

function normalizeQuestionText(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeCatalogName(name) {
  return (name || '').trim().toLowerCase();
}

/**
 * Drops exact-duplicate questions within one extraction batch (the model
 * occasionally repeats itself on long/repetitive papers), keeping the first
 * occurrence and preserving its original field names. Pure, synchronous —
 * unit-testable without a live LLM call.
 *
 * @param {Array<{question: string, options?: string[], correctAnswer?: string, year?: string}>} rawQuestions
 * @returns {Array} same shape, plus `normalizedText`, deduplicated
 */
function dedupeQuestions(rawQuestions) {
  const seen = new Set();
  const result = [];
  for (const q of rawQuestions || []) {
    if (!q.question || !q.question.trim()) continue;
    const normalizedText = normalizeQuestionText(q.question);
    if (seen.has(normalizedText)) continue;
    seen.add(normalizedText);
    result.push({ ...q, normalizedText });
  }
  return result;
}

/**
 * Extracts a plausible 4-digit exam year from Phase 3's loosely-formatted
 * `year` string (e.g. "2021", "2021-22", "Dec 2021"). Never invents a year
 * that isn't actually present in the text. Pure, synchronous.
 *
 * @param {string|undefined} rawYear
 * @returns {number|null}
 */
function parseYear(rawYear) {
  if (!rawYear) return null;
  const match = String(rawYear).match(/(19|20)\d{2}/);
  if (!match) return null;
  return parseInt(match[0], 10);
}

/**
 * Validates the model's per-question topic assignments against the real
 * syllabus catalog, exactly like Phase 5's validateMappings but keyed by
 * question label instead of building DB rows directly. A topicName that
 * isn't an exact match for something in `targetByName` is dropped — never
 * guessed at. Pure, synchronous.
 *
 * @param {Array} rawMappings - the model's { questionLabel, topicName, confidence } items
 * @param {Map} targetByName - from TopicMappingService.buildCatalog()
 * @returns {Map<string, {topicId, subtopicId, confidence, status}>} keyed by questionLabel
 */
function validateQuestionMappings(rawMappings, targetByName) {
  const byLabel = new Map();
  for (const m of rawMappings || []) {
    const target = targetByName.get(normalizeCatalogName(m.topicName));
    if (!target) continue; // invalid AI output — not a real syllabus node, dropped

    const confidence = typeof m.confidence === 'number' ? m.confidence : 0;
    byLabel.set(m.questionLabel, {
      topicId: target.topicId,
      subtopicId: target.subtopicId,
      confidence,
      status: confidence >= CONFIDENCE_THRESHOLD ? 'CONFIRMED' : 'PENDING_REVIEW',
    });
  }
  return byLabel;
}

class PyqIntelligenceService {
  /**
   * Extracts this PYQ document's questions (from the Phase 3
   * ResourceExtraction), deduplicates them, maps each to a single syllabus
   * topic, and persists them as PyqQuestion rows — replacing any previous
   * rows for this document. Returns null when there's nothing to do (not a
   * PYQ resource, no exam linked, no syllabus yet, or no extracted
   * questions), and [] when it ran but found no questions worth keeping.
   *
   * @param {string} documentId
   * @returns {Promise<Array|null>}
   */
  static async run(documentId) {
    const document = await prisma.document.findUnique({
      where: { id: documentId },
      include: { extraction: true },
    });
    if (!document || !document.examId) return null;

    const effectiveType = document.aiCategory || document.category;
    if (effectiveType !== 'PYQ') return null;

    const rawQuestions = document.extraction?.questions;
    if (!Array.isArray(rawQuestions) || rawQuestions.length === 0) return null;

    const exam = await prisma.exam.findUnique({
      where: { id: document.examId },
      include: { subjects: { include: { topics: { include: { subtopics: true } } } } },
    });
    if (!exam || exam.subjects.length === 0) return null;

    const { catalogText, targetByName } = TopicMappingService.buildCatalog(exam.subjects);
    if (targetByName.size === 0) return null;

    const deduped = dedupeQuestions(rawQuestions).slice(0, MAX_QUESTIONS_PER_RUN);
    if (deduped.length === 0) return [];

    const labeled = deduped.map((q, i) => ({ ...q, label: `Q${i + 1}` }));
    const questionsBlock = labeled.map((q) => `${q.label}: ${q.question}`).join('\n');

    const rawResult = await PyqIntelligenceService._generateMappings(catalogText, questionsBlock);
    const mappingByLabel = validateQuestionMappings(rawResult?.mappings, targetByName);

    const rows = labeled.map((q) => {
      const match = mappingByLabel.get(q.label);
      return {
        documentId,
        topicId: match?.topicId ?? null,
        subtopicId: match?.subtopicId ?? null,
        questionText: q.question,
        normalizedText: q.normalizedText,
        options: Array.isArray(q.options) ? q.options : undefined,
        correctAnswer: q.correctAnswer || null,
        year: parseYear(q.year),
        confidence: match?.confidence ?? null,
        status: match?.status ?? 'PENDING_REVIEW',
      };
    });

    try {
      await prisma.$transaction([
        prisma.pyqQuestion.deleteMany({ where: { documentId } }),
        ...(rows.length > 0 ? [prisma.pyqQuestion.createMany({ data: rows })] : []),
      ]);
    } catch (error) {
      if (isRecordGoneError(error)) return null;
      throw error;
    }

    return rows;
  }

  /**
   * Deterministic "historical importance" for one topic: how often, how
   * recently, and across how many distinct years its PYQ questions have
   * appeared. See pyqFrequency.service.js — no AI involved in the scoring.
   *
   * @param {string} topicId
   * @param {Object} [config] - overrides for computeTopicFrequency
   */
  static async getTopicFrequency(topicId, config = {}) {
    const questions = await prisma.pyqQuestion.findMany({
      where: { topicId, status: { not: 'REJECTED' } },
      select: { year: true },
    });
    const currentYear = new Date().getFullYear();
    return computeTopicFrequency(questions, currentYear, config);
  }

  /**
   * The same scoring, batched across every topic in an exam in one query —
   * so a caller building a view over many topics at once (e.g. the Phase 9
   * planner) doesn't pay an N+1 round trip per topic.
   *
   * @param {string} examId
   * @param {Object} [config] - overrides for computeTopicFrequency
   * @returns {Promise<Map<string, ReturnType<typeof computeTopicFrequency>>>} keyed by topicId
   */
  static async getExamFrequency(examId, config = {}) {
    const questions = await prisma.pyqQuestion.findMany({
      where: { topicId: { not: null }, status: { not: 'REJECTED' }, topic: { subject: { examId } } },
      select: { topicId: true, year: true },
    });
    const currentYear = new Date().getFullYear();

    const byTopic = new Map();
    questions.forEach((q) => {
      if (!byTopic.has(q.topicId)) byTopic.set(q.topicId, []);
      byTopic.get(q.topicId).push({ year: q.year });
    });

    const result = new Map();
    byTopic.forEach((qs, topicId) => result.set(topicId, computeTopicFrequency(qs, currentYear, config)));
    return result;
  }

  static async _generateMappings(catalog, questionsBlock) {
    const parser = StructuredOutputParser.fromZodSchema(mappingSchema);
    const llm = new ChatGoogleGenerativeAI({
      apiKey: config.gemini.apiKey,
      model: 'gemini-3.5-flash-lite',
      temperature: 0,
    });
    const prompt = PromptTemplate.fromTemplate(`
You are mapping individual previous-year exam questions onto a course syllabus.

SYLLABUS TOPICS (choose ONLY from this list, using the exact name given):
{catalog}

QUESTIONS:
{questionsBlock}

INSTRUCTIONS:
- For each question, identify the SINGLE most relevant syllabus topic or subtopic it primarily tests — even if a question touches more than one area, pick the one it's most centrally about.
- Use the exact name as given in the syllabus list — do not paraphrase or invent a new name.
- If a question doesn't clearly match any syllabus topic, omit it from the mappings entirely.
- Do NOT output markdown code blocks. Just output raw JSON.

{format_instructions}
`);
    const chain = RunnableSequence.from([prompt, llm, parser]);

    try {
      return await withRetry(() =>
        chain.invoke({ catalog, questionsBlock, format_instructions: parser.getFormatInstructions() })
      );
    } catch (error) {
      console.error('PYQ question-topic mapping failed:', error);
      return null;
    }
  }
}

module.exports = PyqIntelligenceService;
module.exports.dedupeQuestions = dedupeQuestions;
module.exports.parseYear = parseYear;
module.exports.validateQuestionMappings = validateQuestionMappings;
