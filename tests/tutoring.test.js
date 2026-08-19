const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const EmbeddingService = require('../src/ai/services/embedding.service');
const { randomUUID } = require('crypto');

const generateToken = (id) =>
  jwt.sign({ id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

describe('Interactive Tutoring Session API', () => {
  let token;
  let testUser;
  let sessionId;

  beforeAll(async () => {
    testUser = await prisma.user.create({
      data: { name: 'Tutor User', email: 'tutor_interactive@example.com', passwordHash: 'hashed' }
    });
    token = generateToken(testUser.id);

    // Seed a document chunk so RAG has context
    const doc = await prisma.document.create({
      data: {
        userId: testUser.id,
        title: 'DBMS Normalization',
        fileName: 'dbms.txt',
        filePath: '/dummy/dbms.txt',
        fileType: 'text/plain',
        fileSize: 150,
        processingStatus: 'READY',
      }
    });

    const content = `Normalization is the process of organizing a database to reduce redundancy.
      1NF (First Normal Form): Each column must contain atomic values.
      2NF (Second Normal Form): Must be in 1NF and all non-key attributes must depend on the entire primary key.
      3NF (Third Normal Form): Must be in 2NF and no transitive dependencies.
      BCNF (Boyce-Codd Normal Form): A stronger form of 3NF.`;

    const embedding = await EmbeddingService.generateEmbedding(content);
    const vectorStr = `[${embedding.join(',')}]`;

    await prisma.$executeRaw`
      INSERT INTO "DocumentChunk" ("id", "documentId", "content", "chunkIndex", "embedding")
      VALUES (${randomUUID()}, ${doc.id}, ${content}, 0, ${vectorStr}::vector)
    `;
  });

  afterAll(async () => {
    await prisma.tutorSession.deleteMany({ where: { userId: testUser.id } });
    await prisma.documentChunk.deleteMany({});
    await prisma.document.deleteMany({ where: { userId: testUser.id } });
    await prisma.user.delete({ where: { id: testUser.id } });
    await prisma.$disconnect();
  });

  // --------------------------------------------------------
  // TEST 1: Validation
  // --------------------------------------------------------
  it('should return 400 if subject or topic is missing', async () => {
    const res = await request(app)
      .post('/api/tutoring/session/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'DBMS' }); // Missing topic

    expect(res.statusCode).toEqual(400);
  });

  // --------------------------------------------------------
  // TEST 2: Start Session
  // --------------------------------------------------------
  it('should start a tutoring session and return an AI message', async () => {
    const res = await request(app)
      .post('/api/tutoring/session/start')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'DBMS', topic: 'Normalization' });

    expect(res.statusCode).toEqual(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('sessionId');
    expect(res.body.data).toHaveProperty('aiMessage');
    expect(typeof res.body.data.aiMessage).toBe('string');
    expect(res.body.data.aiMessage.length).toBeGreaterThan(10);
    expect(res.body.data.sessionStatus).toBe('ACTIVE');

    // Save sessionId for next test
    sessionId = res.body.data.sessionId;

    // Verify session was persisted to DB
    const dbSession = await prisma.tutorSession.findUnique({ where: { id: sessionId } });
    expect(dbSession).not.toBeNull();
    expect(dbSession.status).toBe('ACTIVE');
    expect(dbSession.topic).toBe('Normalization');
  }, 60000);

  // --------------------------------------------------------
  // TEST 3: Respond to session
  // --------------------------------------------------------
  it('should process a student answer and return a follow-up AI message', async () => {
    // First ensure we have a sessionId
    expect(sessionId).toBeDefined();

    const res = await request(app)
      .post(`/api/tutoring/session/${sessionId}/respond`)
      .set('Authorization', `Bearer ${token}`)
      .send({ answer: 'Normalization removes data redundancy by organizing tables into normal forms like 1NF, 2NF, and 3NF.' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('aiMessage');
    expect(res.body.data).toHaveProperty('questionCount');
    expect(res.body.data.questionCount).toBe(2); // Should have incremented
    expect(res.body.data).toHaveProperty('sessionStatus');
  }, 60000);

  // --------------------------------------------------------
  // TEST 4: Get Session
  // --------------------------------------------------------
  it('should retrieve session details with conversation history', async () => {
    expect(sessionId).toBeDefined();

    const res = await request(app)
      .get(`/api/tutoring/session/${sessionId}`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.statusCode).toEqual(200);
    expect(res.body.data).toHaveProperty('conversationHistory');
    expect(Array.isArray(res.body.data.conversationHistory)).toBe(true);
    // Should have at least the initial AI message + student answer + AI response
    expect(res.body.data.conversationHistory.length).toBeGreaterThanOrEqual(3);
  });
});
