const { PDFLoader } = require('@langchain/community/document_loaders/fs/pdf');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const prisma = require('../../config/db');
const fs = require('fs');
const EmbeddingService = require('./embedding.service');

class DocumentProcessingService {
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
        throw new Error('Document not found');
      }

      // 2. Set status to PROCESSING
      await prisma.document.update({
        where: { id: documentId },
        data: { processingStatus: 'PROCESSING' },
      });

      // 3. Load Document based on file type
      let docs = [];
      if (document.fileType === 'application/pdf') {
        const loader = new PDFLoader(document.filePath);
        docs = await loader.load();
      } else if (
        document.fileType === 'text/plain' || 
        document.fileType === 'text/markdown' ||
        document.fileName.endsWith('.md') ||
        document.fileName.endsWith('.txt')
      ) {
        const text = fs.readFileSync(document.filePath, 'utf-8');
        docs = [{ pageContent: text, metadata: { source: document.filePath } }];
      } else {
        throw new Error(`Unsupported file type for processing: ${document.fileType}`);
      }

      // 4. Clean & Chunk Text
      // LangChain's loaders return an array of Document objects. We merge them or split them directly.
      const textSplitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200,
      });

      const splitDocs = await textSplitter.splitDocuments(docs);

      // 5. Generate embeddings and store chunks
      const textsToEmbed = splitDocs.map(doc => doc.pageContent);
      let embeddings = [];
      try {
        embeddings = await EmbeddingService.generateEmbeddings(textsToEmbed);
      } catch (err) {
        console.error("Failed to generate embeddings, proceeding without them", err);
      }

      // We use raw SQL to insert the vector since Prisma doesn't natively support it in createMany
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

      // 6. Set status to READY
      await prisma.document.update({
        where: { id: documentId },
        data: { processingStatus: 'READY' },
      });

      return true;
    } catch (error) {
      console.error(`Failed to process document ${documentId}:`, error);
      
      // Mark as FAILED
      await prisma.document.update({
        where: { id: documentId },
        data: { processingStatus: 'FAILED' },
      }).catch(err => console.error('Failed to update status to FAILED:', err));

      throw error;
    }
  }
}

module.exports = DocumentProcessingService;
