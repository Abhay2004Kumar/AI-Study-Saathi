const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const { PromptTemplate } = require('@langchain/core/prompts');
const { StructuredOutputParser } = require('@langchain/core/output_parsers');
const { z } = require('zod');
const { RunnableSequence } = require('@langchain/core/runnables');
const { PGVectorRetriever } = require('../retrievers/pgvector.retriever');
const { withRetry } = require('../utils/withRetry');
const prisma = require('../../config/db');
const config = require('../../config/env');

const MIN_CARDS = 1;
const MAX_CARDS = 20;
const RETRIEVAL_TOP_K = 12;

const flashcardSchema = z.object({
  flashcards: z.array(
    z.object({
      front: z.string().describe('The question or term on the front of the flashcard'),
      back: z.string().describe('The answer or definition on the back of the flashcard'),
      hint: z.string().optional().describe('An optional hint that nudges without revealing the answer'),
    })
  ).describe('The array of flashcard objects in this deck'),
});

function normalizeFrontText(text) {
  return (text || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Drops a new card whose front matches one already in this batch, or one
// already persisted for the topic (existingNormalizedFronts) — keeping the
// first occurrence. Pure, DB/AI-free, so it's directly unit-testable.
function dedupeFlashcards(cards, existingNormalizedFronts = new Set()) {
  const seen = new Set(existingNormalizedFronts);
  const result = [];
  for (const card of cards || []) {
    if (!card || !card.front || !card.front.trim()) continue;
    const key = normalizeFrontText(card.front);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(card);
  }
  return result;
}

class FlashcardService {
  /**
   * Generates topic-scoped flashcards and adds them to the topic's deck.
   * Unlike Quiz/StudyPlan, generating again does not replace anything —
   * cards already mid-repetition-schedule keep their state; this only adds
   * new, non-duplicate cards on top.
   *
   * @param {Object} params
   * @param {string} params.userId
   * @param {string} params.examId
   * @param {string} params.subjectId
   * @param {string} params.topicId
   * @param {string} params.topicName
   * @param {string} [params.subtopicId]
   * @param {string} [params.subtopicName]
   * @param {number} [params.numberOfCards]
   * @returns {Promise<Array<Object>|null>} the newly created cards, or null if there was nothing to generate from
   */
  static async generateFlashcards({
    userId,
    examId,
    subjectId,
    topicId,
    topicName,
    subtopicId = null,
    subtopicName = null,
    numberOfCards = 10,
  }) {
    const count = Math.min(MAX_CARDS, Math.max(MIN_CARDS, Number(numberOfCards) || 10));

    const mappings = await prisma.resourceTopicMapping.findMany({
      where: {
        topicId,
        subtopicId: subtopicId || undefined,
        status: { not: 'REJECTED' },
        document: { userId },
      },
      select: { documentId: true },
    });
    const mappedDocumentIds = [...new Set(mappings.map((m) => m.documentId))];

    const retriever = new PGVectorRetriever({
      userId,
      examId,
      topK: RETRIEVAL_TOP_K,
      documentIds: mappedDocumentIds.length > 0 ? mappedDocumentIds : undefined,
    });
    const searchQuery = subtopicName ? `${topicName} ${subtopicName} key concepts and terms` : `${topicName} key concepts and terms`;
    const docs = await retriever.invoke(searchQuery);
    if (docs.length === 0) return null;

    const contextText = docs
      .map((doc, i) => `Source S${i + 1} (${doc.metadata.title || 'Unknown'}):\n${doc.pageContent}`)
      .join('\n\n');
    const sourceDocumentIds = [...new Set(docs.map((d) => d.metadata.documentId))];

    const parser = StructuredOutputParser.fromZodSchema(flashcardSchema);
    const llm = new ChatGoogleGenerativeAI({
      model: 'gemini-3.5-flash-lite',
      temperature: 0.3,
      apiKey: config.gemini.apiKey,
    });

    const prompt = PromptTemplate.fromTemplate(`
You are an expert study-aid AI specializing in concise, effective flashcards.
Generate a flashcard deck based ONLY on the provided study material.

TOPIC: {topic}
NUMBER OF CARDS: {numberOfCards}

STUDY MATERIAL:
{context}

INSTRUCTIONS:
- Generate exactly {numberOfCards} flashcards.
- Base every card ONLY on the study material above — never invent facts outside it.
- Each card must cover a distinct fact or concept — no near-duplicates of each other.
- "front" is a clear, concise question or term. "back" is the answer or definition, brief but complete.
- Optionally include a short "hint" that nudges without revealing the answer.
- Every field is displayed as plain text with no math or markdown rendering. NEVER use LaTeX syntax (no $...$, \\(...\\), \\rightarrow, \\ge, etc.) and never wrap terms in markdown (no **bold**, no backticks). Write formulas and notation in plain words or ordinary keyboard/unicode symbols instead — e.g. "X -> A" or "X → A", ">=", "<=", "!=".
- Do NOT output markdown code blocks (e.g. \`\`\`json). Just output raw JSON.

{format_instructions}
`);

    const chain = RunnableSequence.from([prompt, llm, parser]);
    const result = await withRetry(() =>
      chain.invoke({
        topic: subtopicName ? `${topicName} — ${subtopicName}` : topicName,
        numberOfCards: count.toString(),
        context: contextText,
        format_instructions: parser.getFormatInstructions(),
      })
    );

    const existing = await prisma.flashcard.findMany({
      where: { userId, topicId },
      select: { normalizedFront: true },
    });
    const deduped = dedupeFlashcards(result.flashcards, new Set(existing.map((e) => e.normalizedFront)));
    if (deduped.length === 0) return [];

    await prisma.flashcard.createMany({
      data: deduped.map((c) => ({
        userId,
        subjectId,
        topicId,
        subtopicId,
        front: c.front,
        back: c.back,
        hint: c.hint || null,
        normalizedFront: normalizeFrontText(c.front),
        sourceDocumentIds,
      })),
    });

    return prisma.flashcard.findMany({
      where: { userId, topicId, normalizedFront: { in: deduped.map((c) => normalizeFrontText(c.front)) } },
      orderBy: { createdAt: 'desc' },
      take: deduped.length,
    });
  }
}

module.exports = FlashcardService;
module.exports.normalizeFrontText = normalizeFrontText;
module.exports.dedupeFlashcards = dedupeFlashcards;
