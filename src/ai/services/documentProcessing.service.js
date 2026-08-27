const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const prisma = require('../../config/db');
const EmbeddingService = require('./embedding.service');
const { loadDocumentAsLangchainDocs } = require('../utils/documentLoader');
const IngestionService = require('./ingestion.service');
const TopicMappingService = require('./topicMapping.service');
const PyqIntelligenceService = require('./pyqIntelligence.service');
const { isRecordGoneError } = require('../../utils/prismaErrors');

async function safeStatusUpdate(documentId, data) {
  try {
    await prisma.document.update({ where: { id: documentId }, data });
  } catch (error) {
    if (isRecordGoneError(error)) {
      console.log(`Document ${documentId} was deleted before its status could be updated to ${data.processingStatus}; skipping.`);
      return;
    }
    throw error;
  }
}

// Tracks every currently-running fire-and-forget processDocument() call so
// waitForAllBackgroundProcessing() (used by tests, and available to any
// caller that genuinely needs to know when the queue is idle) can drain them
// deterministically instead of guessing from DB status, which can't tell the
// difference between "still running" and "the document was deleted while it
// was still running" — exactly the gap that let orphaned jobs outlive a
// test's cleanup and throw once Prisma/the process was already torn down.
const inFlight = new Set();

class DocumentProcessingService {
  /**
   * Fire-and-forget entry point for production call sites (upload, retry):
   * kicks off processDocument() without blocking the HTTP response, but
   * still registers the promise so it can be waited on later if needed.
   * @param {string} documentId
   */
  static processInBackground(documentId) {
    const promise = DocumentProcessingService.processDocument(documentId).catch((err) => {
      console.error('Background processing failed:', err);
    });
    inFlight.add(promise);
    promise.finally(() => inFlight.delete(promise));
    return promise;
  }

  /** Resolves once every currently-tracked background job has settled. */
  static async waitForAllBackgroundProcessing() {
    // New work can be added while draining, so loop until the set is
    // actually empty rather than awaiting one static snapshot.
    while (inFlight.size > 0) {
      await Promise.allSettled([...inFlight]);
    }
  }

  /**
   * Process a document: Load, Extract Text, Chunk, and Store Chunks
   * @param {string} documentId
   */
  static async processDocument(documentId) {
    try {
      // 1. Fetch document
      const document = await prisma.document.findUnique({
        where: { id: documentId },
      });

      if (!document) {
        // Already deleted before processing even started — nothing to do.
        return true;
      }

      // 2. Set status to PROCESSING
      await safeStatusUpdate(documentId, { processingStatus: 'PROCESSING' });

      // 3. Load Document based on file type — for an image this runs OCR
      // (ai/services/ocr.service.js) and returns an empty array rather than
      // throwing if nothing legible was found, so that case falls straight
      // into the empty-content guard below instead of needing its own path.
      const docs = await loadDocumentAsLangchainDocs(document.filePath, document.fileType, document.fileName);

      // LangChain's PDFLoader returns one Document per page, so its length
      // is the page count; other formats don't have a meaningful page count.
      if (document.fileType === 'application/pdf') {
        await safeStatusUpdate(documentId, { pageCount: docs.length });
      }

      // 4. Clean & Chunk Text
      // LangChain's loaders return an array of Document objects. We merge them or split them directly.
      const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
      });

      const splitDocs = await textSplitter.splitDocuments(docs);

      // Nothing extractable (an image with no legible text, or a blank
      // file) — nothing to embed, map, or classify. Ready, with zero chunks,
      // rather than forcing every downstream step to handle an empty input.
      if (splitDocs.length === 0) {
        await safeStatusUpdate(documentId, { processingStatus: 'READY' });
        return true;
      }

      // 5. Generate embeddings and store chunks
      const textsToEmbed = splitDocs.map(doc => doc.pageContent);
      let embeddings = [];
      try {
        embeddings = await EmbeddingService.generateEmbeddings(textsToEmbed);
      } catch (err) {
        console.error("Failed to generate embeddings, proceeding without them", err);
      }

      // We use raw SQL to insert the vector since Prisma doesn't natively support it in createMany
      try {
        for (let i = 0; i < splitDocs.length; i++) {
          const content = splitDocs[i].pageContent;
          const metadata = JSON.stringify(splitDocs[i].metadata || {});
          let embeddingVector = null;

          if (embeddings.length > 0 && embeddings[i]) {
            embeddingVector = `[${embeddings[i].join(',')}]`;

            await prisma.$executeRaw`
              INSERT INTO "DocumentChunk" ("id", "documentId", "content", "chunkIndex", "metadata", "embedding")
              VALUES (gen_random_uuid(), ${document.id}, ${content}, ${i}, ${metadata}::jsonb, ${embeddingVector}::vector)
            `;
          } else {
            await prisma.documentChunk.create({
              data: {
                documentId: document.id,
                content: content,
                chunkIndex: i,
                metadata: splitDocs[i].metadata || {},
              }
            });
          }
        }
      } catch (error) {
        if (isRecordGoneError(error)) {
          console.log(`Document ${documentId} was deleted mid-processing; abandoning the rest of its chunks.`);
          return true;
        }
        throw error;
      }

      // 6. Run the Phase 3 ingestion pipeline (classify + type-specific
      // extraction). This is best-effort: a document is already useful for
      // RAG once its chunks are stored, so a classification failure
      // shouldn't flip the whole document to FAILED.
      try {
        await IngestionService.run(documentId, splitDocs, document.category);
      } catch (error) {
        console.error(`Ingestion pipeline failed for document ${documentId}, continuing without it:`, error);
      }

      // 7. Run Phase 5 topic mapping — also best-effort, and a no-op unless
      // the document is linked to an exam that already has a syllabus.
      try {
        await TopicMappingService.run(documentId);
      } catch (error) {
        console.error(`Topic mapping failed for document ${documentId}, continuing without it:`, error);
      }

      // 8. Run Phase 6 PYQ intelligence — best-effort, and a no-op unless
      // this is a PYQ resource with questions actually extracted.
      try {
        await PyqIntelligenceService.run(documentId);
      } catch (error) {
        console.error(`PYQ question mapping failed for document ${documentId}, continuing without it:`, error);
      }

      // 9. Set status to READY
      await safeStatusUpdate(documentId, { processingStatus: 'READY' });

      return true;
    } catch (error) {
      console.error(`Failed to process document ${documentId}:`, error);

      // Mark as FAILED (safeStatusUpdate already tolerates the row being gone)
      await safeStatusUpdate(documentId, { processingStatus: 'FAILED' }).catch((err) =>
        console.error('Failed to update status to FAILED:', err)
      );

      throw error;
    }
  }
}

module.exports = DocumentProcessingService;
