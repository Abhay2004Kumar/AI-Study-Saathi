const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const EmbeddingService = require('../src/ai/services/embedding.service');

describe('Basic RAG API', () => {
  // Use a longer timeout because we are querying Gemini
  jest.setTimeout(25000);

  let token;
  let userId;
  let docId = 'rag-test-doc-id';

  beforeAll(async () => {
    // 1. Create a user
    const user = await prisma.user.create({
      data: {
        name: 'RAG Tester',
        email: 'rag@test.com',
        passwordHash: 'hash',
      },
    });
    userId = user.id;

    token = jwt.sign({ id: user.id }, config.jwt.secret, {
      expiresIn: config.jwt.expiresIn,
    });

    // 2. Insert a document
    await prisma.$executeRaw`
      INSERT INTO "Document" ("id", "userId", "title", "fileName", "filePath", "fileType", "fileSize", "updatedAt")
      VALUES (${docId}, ${user.id}, 'Space Exploration', 'space.txt', '/tmp/space.txt', 'text/plain', 100, NOW())
    `;

    // 3. Insert chunk with actual embeddings
    const text = 'The first artificial Earth satellite was Sputnik 1, launched by the Soviet Union in 1957.';
    const queryEmbedding = await EmbeddingService.generateEmbedding(text);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    await prisma.$executeRaw`
      INSERT INTO "DocumentChunk" ("id", "documentId", "content", "chunkIndex", "embedding")
      VALUES (gen_random_uuid(), ${docId}, ${text}, 0, ${vectorStr}::vector)
    `;
  });

  afterAll(async () => {
    // Clean up
    await prisma.$executeRaw`DELETE FROM "DocumentChunk" WHERE "documentId" = ${docId}`;
    await prisma.$executeRaw`DELETE FROM "Document" WHERE "id" = ${docId}`;
    await prisma.$executeRaw`DELETE FROM "User" WHERE "email" = 'rag@test.com'`;
    await prisma.$disconnect();
  });

  it('should answer a question using context from the database', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({
        question: 'What was the first artificial satellite and when was it launched?',
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('answer');
    
    // The answer should contain Sputnik and 1957
    expect(res.body.data.answer).toMatch(/Sputnik 1/i);
    expect(res.body.data.answer).toMatch(/1957/);
    
    console.log("RAG Answer:", res.body.data.answer);
  });
  
  it('should return 400 if question is missing', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({});
      
    expect(res.statusCode).toEqual(400);
  });
});
