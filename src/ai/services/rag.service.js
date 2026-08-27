const { ChatGoogleGenerativeAI } = require('@langchain/google-genai');
const config = require('../../config/env');
const { PGVectorRetriever } = require('../retrievers/pgvector.retriever');
const { buildRagChain, formatSourcesForPrompt } = require('../chains/rag.chain');
const { withRetry } = require('../utils/withRetry');

class RAGService {
  constructor() {
    this.llm = new ChatGoogleGenerativeAI({
      apiKey: config.gemini.apiKey,
      model: 'gemini-3.5-flash-lite',
      temperature: 0.2, // Low temperature for more factual answers
    });
  }

  /**
   * Retrieves relevant chunks from the database and uses them to answer the
   * user's question, strictly scoped to that user's own resources.
   *
   * @param {string} userId - The ID of the user asking the question
   * @param {string} question - The user's question
   * @param {Object} [filters]
   * @param {string} [filters.examId] - scope retrieval to one exam's resources
   * @param {string} [filters.category] - scope retrieval to one resource category (SYLLABUS/NOTES/PYQ/GENERAL)
   * @returns {Promise<{answer: string, foundInMaterials: boolean, sources: Array<{title: string, page: number|null}>}>}
   */
  async askQuestion(userId, question, filters = {}) {
    if (!question || !question.trim()) {
      throw new Error('Question cannot be empty');
    }

    // Retrieve once — the same docs are used both to build the prompt
    // context and afterward to validate whatever sources the model claims
    // to have used, instead of retrieving twice and risking the two calls
    // drifting apart.
    const retriever = new PGVectorRetriever({
      userId,
      topK: 5,
      examId: filters.examId,
      category: filters.category,
    });
    const docs = await retriever.invoke(question);

    let result;
    try {
      const chain = await buildRagChain(this.llm);
      result = await withRetry(() =>
        chain.invoke({ context: formatSourcesForPrompt(docs), question })
      );
    } catch (error) {
      console.error('RAG generation failed:', error);
      throw new Error('Failed to generate an answer');
    }

    return {
      answer: result.answer,
      foundInMaterials: Boolean(result.foundInMaterials) && docs.length > 0,
      sources: this._resolveSources(docs, result),
    };
  }

  /**
   * Never trust the model's own citation claims outright: every id it
   * reports is cross-checked against what was actually retrieved, and the
   * whole list is forced empty whenever the model says (or we independently
   * know, because nothing was retrieved) that nothing relevant was found.
   * This is what actually prevents a hallucinated source, not the prompt
   * asking nicely.
   */
  _resolveSources(docs, result) {
    if (docs.length === 0 || !result.foundInMaterials) {
      return [];
    }

    const usedIds = new Set(Array.isArray(result.usedSourceIds) ? result.usedSourceIds : []);
    const seen = new Set();
    const sources = [];

    docs.forEach((doc, i) => {
      const id = `S${i + 1}`;
      if (!usedIds.has(id)) return;

      const key = `${doc.metadata.title}::${doc.metadata.page ?? ''}`;
      if (seen.has(key)) return;
      seen.add(key);

      sources.push({ title: doc.metadata.title, page: doc.metadata.page ?? null });
    });

    return sources;
  }
}

module.exports = new RAGService();
