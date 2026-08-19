const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const EmbeddingService = require('../src/ai/services/embedding.service');

const generateToken = (id) => {
  return jwt.sign({ id }, config.jwt.secret, {
    expiresIn: config.jwt.expiresIn,
  });
};

describe('LangGraph Tutor API', () => {
  let token;
  let testUser;
  let testDocument;
  let testChunk;

  beforeAll(async () => {
    // 1. Create a test user
    testUser = await prisma.user.create({
      data: {
        name: 'Graph User',
        email: 'graph@example.com',
        passwordHash: 'hashed_pass'
      }
    });

    token = generateToken(testUser.id);

    // 2. Create a test document
    testDocument = await prisma.document.create({
      data: {
        userId: testUser.id,
        title: 'Quantum Physics Notes',
        fileName: 'quantum.txt',
        filePath: '/uploads/dummy/quantum.txt',
        fileType: 'text/plain',
        fileSize: 100,
        processingStatus: 'READY'
      }
    });

    // 3. Insert a chunk directly using pgvector raw SQL
    const chunkText = "Quantum entanglement is a phenomenon where particles remain connected so that actions performed on one affect the other, even when separated by great distances.";
    const queryEmbedding = await EmbeddingService.generateEmbedding(chunkText);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    const { randomUUID } = require('crypto');
    const chunkId = randomUUID();

    await prisma.$executeRaw`
      INSERT INTO "DocumentChunk" ("id", "documentId", "content", "chunkIndex", "embedding")
      VALUES (${chunkId}, ${testDocument.id}, ${chunkText}, 0, ${vectorStr}::vector)
    `;
  });

  afterAll(async () => {
    await prisma.documentChunk.deleteMany({});
    await prisma.document.deleteMany({});
    await prisma.user.deleteMany({});
    await prisma.$disconnect();
  });

  it('should answer a specific question using context', async () => {
    const res = await request(app)
      .post('/api/tutor/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({
        question: 'What is quantum entanglement?'
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('answer');
    expect(res.body.data).toHaveProperty('sources');
    expect(res.body.data.sources.length).toBeGreaterThan(0);
    expect(res.body.data.sources[0]).toBe('Quantum Physics Notes');
    // LangGraph should normally answer this in 0 loops (first pass)
    expect(res.body.data).toHaveProperty('loops'); 
  }, 30000); // Allow time for LLM calls

  it('should loop and rewrite query when context is missing', async () => {
    const res = await request(app)
      .post('/api/tutor/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({
        // This is not in the notes at all. The graph should retrieve -> generate -> evaluate (fail) -> rewrite -> retrieve -> generate -> evaluate (fail) -> end (due to max loops)
        question: 'What is the theory of relativity?'
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.loops).toBeGreaterThan(0); // Proves that the graph evaluated to false and looped at least once!
  }, 120000); // Allow time for multiple LLM calls
});
