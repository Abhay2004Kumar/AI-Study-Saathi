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

describe('Quiz Generation API', () => {
  let token;
  let testUser;
  let testDocument;

  beforeAll(async () => {
    testUser = await prisma.user.create({
      data: {
        name: 'Quiz User',
        email: 'quiz@example.com',
        passwordHash: 'hashed_pass'
      }
    });

    token = generateToken(testUser.id);

    testDocument = await prisma.document.create({
      data: {
        userId: testUser.id,
        title: 'DBMS Normalization',
        fileName: 'dbms.txt',
        filePath: '/dummy/dbms.txt',
        fileType: 'text/plain',
        fileSize: 100,
        processingStatus: 'READY'
      }
    });

    const chunkText = "Normalization in DBMS is a process to eliminate data redundancy and enhance data integrity. First Normal Form (1NF) ensures that the domain of an attribute must include only atomic values. Second Normal Form (2NF) ensures no partial dependency.";
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

  it('should generate a structured JSON quiz successfully', async () => {
    const res = await request(app)
      .post('/api/ai/quiz/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: 'DBMS',
        topic: 'Normalization',
        numberOfQuestions: 2,
        difficulty: 'medium'
      });

    console.log(res.body);
    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);

    const quiz = res.body.data;
    // Verify it correctly conforms to our Zod schema
    expect(quiz).toHaveProperty('subject', 'DBMS');
    expect(quiz).toHaveProperty('topic', 'Normalization');
    expect(quiz).toHaveProperty('difficulty', 'medium');
    expect(quiz).toHaveProperty('questions');
    expect(Array.isArray(quiz.questions)).toBe(true);
    expect(quiz.questions.length).toBe(2);

    // Verify first question structure
    const q1 = quiz.questions[0];
    expect(q1).toHaveProperty('question');
    expect(q1).toHaveProperty('options');
    expect(Array.isArray(q1.options)).toBe(true);
    expect(q1.options.length).toBe(4);
    expect(q1).toHaveProperty('correctAnswer');
    expect(q1).toHaveProperty('explanation');
  }, 30000); // Allow time for LLM call
});
