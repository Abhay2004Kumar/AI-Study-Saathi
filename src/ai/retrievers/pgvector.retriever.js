const { BaseRetriever } = require('@langchain/core/retrievers');
const { Document } = require('@langchain/core/documents');
const prisma = require('../../config/db');
const EmbeddingService = require('../services/embedding.service');

class PGVectorRetriever extends BaseRetriever {
  lc_namespace = ["langchain", "retrievers"];

  constructor(fields) {
    super(fields);
    this.userId = fields.userId;
    this.topK = fields.topK || 3;
  }

  async _getRelevantDocuments(query) {
    // 1. Generate an embedding for the user's query
    const queryEmbedding = await EmbeddingService.generateEmbedding(query);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    // 2. Query pgvector for the closest matches for this specific user
    const topChunks = await prisma.$queryRaw`
      SELECT c.content, d.title, (c."embedding" <=> ${vectorStr}::vector) as distance
      FROM "DocumentChunk" c
      JOIN "Document" d ON c."documentId" = d.id
      WHERE d."userId" = ${this.userId}
      ORDER BY c."embedding" <=> ${vectorStr}::vector
      LIMIT ${this.topK}
    `;

    // 3. Convert raw database records into standard LangChain Document objects
    return topChunks.map(chunk => new Document({
      pageContent: chunk.content,
      metadata: {
        title: chunk.title,
        distance: chunk.distance
      }
    }));
  }
}

module.exports = { PGVectorRetriever };
