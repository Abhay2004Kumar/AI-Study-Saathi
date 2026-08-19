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

describe('Flashcard Generation API', () => {
  let token;
  let testUser;
  let testDocument;

  beforeAll(async () => {
    testUser = await prisma.user.create({
      data: {
        name: 'Flash User',
        email: 'flash@example.com',
        passwordHash: 'hashed_pass'
      }
    });

    token = generateToken(testUser.id);

    testDocument = await prisma.document.create({
      data: {
        userId: testUser.id,
        title: 'Operating Systems Notes',
        fileName: 'os.txt',
        filePath: '/dummy/os.txt',
        fileType: 'text/plain',
        fileSize: 200,
        processingStatus: 'READY'
      }
    });

    const chunkText = `Process scheduling is a mechanism by which the operating system decides which process runs at what time.
      The CPU scheduler selects from among the processes that are ready to execute and allocates the CPU to one of them.
      Types of schedulers include: Short-term scheduler (CPU scheduler), Medium-term scheduler (swapper), and Long-term scheduler (job scheduler).
      Scheduling criteria include: CPU utilization, throughput, turnaround time, waiting time, response time.
      Common algorithms: First Come First Served (FCFS), Shortest Job First (SJF), Round Robin (RR), Priority Scheduling.`;

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

  it('should return 400 if subject or topic is missing', async () => {
    const res = await request(app)
      .post('/api/flashcards/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'OS' }); // Missing topic

    expect(res.statusCode).toEqual(400);
    expect(res.body.success).toBe(false);
  });

  it('should generate a structured JSON flashcard deck successfully', async () => {
    const res = await request(app)
      .post('/api/flashcards/generate')
      .set('Authorization', `Bearer ${token}`)
      .send({
        subject: 'Operating Systems',
        topic: 'Process Scheduling',
        numberOfCards: 3
      });

    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);

    const deck = res.body.data;
    // Verify conformance to our Zod schema
    expect(deck).toHaveProperty('subject');
    expect(deck).toHaveProperty('topic');
    expect(deck).toHaveProperty('flashcards');
    expect(Array.isArray(deck.flashcards)).toBe(true);
    expect(deck.flashcards.length).toBe(3);

    // Verify individual flashcard structure
    const card = deck.flashcards[0];
    expect(card).toHaveProperty('front');
    expect(card).toHaveProperty('back');
    expect(typeof card.front).toBe('string');
    expect(typeof card.back).toBe('string');
  }, 30000);
});
