const { BaseRetriever } = require('@langchain/core/retrievers');
const { Document } = require('@langchain/core/documents');
const { Prisma } = require('@prisma/client');
const prisma = require('../../config/db');
const EmbeddingService = require('../services/embedding.service');

// LangChain's PDFLoader tags each page's Document metadata with
// { loc: { pageNumber } } before chunking, and splitDocuments() copies parent
// metadata onto every chunk — so a PDF-sourced chunk carries its page number
// straight through to DocumentChunk.metadata already. Other formats (txt/md)
// have no such concept, so this is null for them.
function extractPageNumber(metadata) {
  const page = metadata?.loc?.pageNumber;
  return typeof page === 'number' ? page : null;
}

class PGVectorRetriever extends BaseRetriever {
  lc_namespace = ["langchain", "retrievers"];

  /**
   * @param {Object} fields
   * @param {string} fields.userId - required; every query is scoped to this user, never leaking another user's resources.
   * @param {number} [fields.topK]
   * @param {string} [fields.examId] - optional metadata filter: only retrieve chunks from resources linked to this exam.
   * @param {string} [fields.category] - optional metadata filter: only retrieve chunks from resources of this category (SYLLABUS/NOTES/PYQ/GENERAL).
   * @param {string[]} [fields.documentIds] - optional metadata filter: only retrieve chunks from this specific set of documents (e.g. resources already mapped to a topic).
   */
  constructor(fields) {
    super(fields);
    this.userId = fields.userId;
    this.topK = fields.topK || 3;
    this.examId = fields.examId || null;
    this.category = fields.category || null;
    this.documentIds = fields.documentIds && fields.documentIds.length ? fields.documentIds : null;
  }

  async _getRelevantDocuments(query) {
    // 1. Generate an embedding for the user's query
    const queryEmbedding = await EmbeddingService.generateEmbedding(query);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    // 2. Query pgvector for the closest matches for this specific user,
    // optionally narrowed to one exam, resource category, and/or an explicit
    // set of documents.
    const examFilter = this.examId ? Prisma.sql`AND d."examId" = ${this.examId}` : Prisma.empty;
    const categoryFilter = this.category ? Prisma.sql`AND d.category = ${this.category}` : Prisma.empty;
    const documentIdsFilter = this.documentIds
      ? Prisma.sql`AND d.id IN (${Prisma.join(this.documentIds)})`
      : Prisma.empty;

    const topChunks = await prisma.$queryRaw(Prisma.sql`
      SELECT
        c.content,
        c.metadata,
        d.id AS "documentId",
        d.title,
        d."examId",
        d.category,
        (c."embedding" <=> ${vectorStr}::vector) AS distance
      FROM "DocumentChunk" c
      JOIN "Document" d ON c."documentId" = d.id
      WHERE d."userId" = ${this.userId}
      ${examFilter}
      ${categoryFilter}
      ${documentIdsFilter}
      ORDER BY c."embedding" <=> ${vectorStr}::vector
      LIMIT ${this.topK}
    `);

    // 3. Convert raw database records into standard LangChain Document objects
    return topChunks.map(chunk => new Document({
      pageContent: chunk.content,
      metadata: {
        documentId: chunk.documentId,
        title: chunk.title,
        examId: chunk.examId,
        category: chunk.category,
        page: extractPageNumber(chunk.metadata),
        distance: chunk.distance,
      }
    }));
  }
}

module.exports = { PGVectorRetriever };
