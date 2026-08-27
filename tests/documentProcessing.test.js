const DocumentProcessingService = require('../src/ai/services/documentProcessing.service');
const prisma = require('../src/config/db');
const fs = require('fs');
const path = require('path');

describe('Document Processing Service', () => {
  let user;
  let testDoc;
  const testFilePath = path.join(__dirname, 'processing_test.txt');

  beforeAll(async () => {
    // Connect to database
    await prisma.$connect();
    
    // Create a dummy text file
    fs.writeFileSync(testFilePath, 'This is a test paragraph for chunking. '.repeat(100)); // Large enough to split

    // Create a test user
    user = await prisma.user.create({
      data: {
        name: 'Proc Test User',
        email: 'proctest@example.com',
        passwordHash: 'dummyhash',
      }
    });
  });

  afterAll(async () => {
    // Clean up
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    await prisma.documentChunk.deleteMany({ where: { document: { userId: user.id } } });
    await prisma.document.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  });

  it('should process a text document, extract chunks, and update status', async () => {
    // Create a dummy document record
    testDoc = await prisma.document.create({
      data: {
        userId: user.id,
        title: 'Processing Test Doc',
        fileName: 'processing_test.txt',
        filePath: testFilePath,
        fileType: 'text/plain',
        fileSize: 1024,
        processingStatus: 'UPLOADED'
      }
    });

    // Run the processor
    await DocumentProcessingService.processDocument(testDoc.id);

    // Verify document status is READY
    const updatedDoc = await prisma.document.findUnique({ where: { id: testDoc.id } });
    expect(updatedDoc.processingStatus).toBe('READY');

    // Verify chunks were created — ordered explicitly, since findMany's
    // default order isn't guaranteed to match insertion/chunkIndex order.
    const chunks = await prisma.documentChunk.findMany({
      where: { documentId: testDoc.id },
      orderBy: { chunkIndex: 'asc' },
    });
    expect(chunks.length).toBeGreaterThan(0);
    
    // Check chunk content
    expect(chunks[0].content).toContain('This is a test paragraph');
    expect(chunks[0].chunkIndex).toBe(0);
  }, 30000); // classification + extraction + embedding are sequential live LLM calls, well over Jest's 5s default
});
