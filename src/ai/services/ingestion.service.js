const prisma = require('../../config/db');
const { buildIngestionGraph } = require('../graphs/ingestion.graph');
const { isRecordGoneError } = require('../../utils/prismaErrors');

// Matches the classify node's CLASSIFY/EXTRACT_INPUT_CHARS bound — no point
// handing the graph more raw text than any node will actually read.
const MAX_RAW_TEXT_CHARS = 20000;

class IngestionService {
  /**
   * Runs the Phase 3 ingestion pipeline for a document that already has its
   * chunks stored, then persists the result: Document.aiCategory /
   * classificationConfidence, and a ResourceExtraction row holding whatever
   * type-specific structured content the pipeline found.
   *
   * Best-effort by design — a document is already usable for RAG once its
   * chunks exist, so failures here are the caller's concern to swallow, not
   * this service's.
   *
   * @param {string} documentId
   * @param {Array<{pageContent: string}>} splitDocs - already-chunked LangChain docs
   * @param {string} userCategory - the user's category choice at upload time
   */
  static async run(documentId, splitDocs, userCategory) {
    const rawText = splitDocs
      .map((d) => d.pageContent)
      .join('\n\n')
      .slice(0, MAX_RAW_TEXT_CHARS);

    if (!rawText.trim()) {
      return null;
    }

    const graph = buildIngestionGraph();
    const result = await graph.invoke({ documentId, userCategory, rawText });

    try {
      await prisma.document.update({
        where: { id: documentId },
        data: {
          aiCategory: result.resourceType,
          classificationConfidence: result.confidence,
        },
      });

      await prisma.resourceExtraction.upsert({
        where: { documentId },
        create: {
          documentId,
          resourceType: result.resourceType,
          summary: result.summary || null,
          topics: result.topics ?? undefined,
          questions: result.questions ?? undefined,
          confidence: result.confidence,
        },
        update: {
          resourceType: result.resourceType,
          summary: result.summary || null,
          topics: result.topics ?? undefined,
          questions: result.questions ?? undefined,
          confidence: result.confidence,
        },
      });
    } catch (error) {
      if (isRecordGoneError(error)) {
        console.log(`Document ${documentId} was deleted before its ingestion result could be saved; skipping.`);
        return null;
      }
      throw error;
    }

    return result;
  }
}

module.exports = IngestionService;
