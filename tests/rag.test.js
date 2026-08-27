const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const jwt = require('jsonwebtoken');
const config = require('../src/config/env');
const EmbeddingService = require('../src/ai/services/embedding.service');

const genToken = (id) => jwt.sign({ id }, config.jwt.secret, { expiresIn: config.jwt.expiresIn });

async function insertChunk({ documentId, content, chunkIndex = 0, metadata = {} }) {
  const embedding = await EmbeddingService.generateEmbedding(content);
  const vectorStr = `[${embedding.join(',')}]`;
  await prisma.$executeRaw`
    INSERT INTO "DocumentChunk" ("id", "documentId", "content", "chunkIndex", "metadata", "embedding")
    VALUES (gen_random_uuid(), ${documentId}, ${content}, ${chunkIndex}, ${JSON.stringify(metadata)}::jsonb, ${vectorStr}::vector)
  `;
}

describe('Basic RAG API', () => {
  jest.setTimeout(30000);

  let token;
  let userId;
  let docId = 'rag-test-doc-id';

  beforeAll(async () => {
    const user = await prisma.user.create({
      data: { name: 'RAG Tester', email: 'rag@test.com', passwordHash: 'hash' },
    });
    userId = user.id;
    token = genToken(user.id);

    await prisma.$executeRaw`
      INSERT INTO "Document" ("id", "userId", "title", "fileName", "filePath", "fileType", "fileSize", "updatedAt")
      VALUES (${docId}, ${user.id}, 'Space Exploration', 'space.txt', '/tmp/space.txt', 'text/plain', 100, NOW())
    `;

    await insertChunk({
      documentId: docId,
      content: 'The first artificial Earth satellite was Sputnik 1, launched by the Soviet Union in 1957.',
    });
  });

  afterAll(async () => {
    // No $disconnect() here — the shared Prisma client is still needed by
    // the second describe block below, in this same file.
    await prisma.$executeRaw`DELETE FROM "DocumentChunk" WHERE "documentId" = ${docId}`;
    await prisma.$executeRaw`DELETE FROM "Document" WHERE "id" = ${docId}`;
    await prisma.$executeRaw`DELETE FROM "User" WHERE "email" = 'rag@test.com'`;
  });

  it('should answer a question using context from the database', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({ question: 'What was the first artificial satellite and when was it launched?' });

    expect(res.statusCode).toEqual(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveProperty('answer');
    expect(res.body.data.answer).toMatch(/Sputnik 1/i);
    expect(res.body.data.answer).toMatch(/1957/);
    expect(res.body.data.foundInMaterials).toBe(true);
    expect(res.body.data.sources.some((s) => s.title === 'Space Exploration')).toBe(true);
  });

  it('should return 400 if question is missing', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.statusCode).toEqual(400);
  });
});

describe('RAG source citation, isolation, and metadata filtering', () => {
  jest.setTimeout(45000);

  const owner = { name: 'RAG Owner', email: 'ragowner@test.com', password: 'password123' };
  const intruder = { name: 'RAG Intruder', email: 'ragintruder@test.com', password: 'password123' };

  let ownerToken, intruderToken, ownerId;
  let dbmsDocId, osDocId, examId;

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });

    let res = await request(app).post('/api/auth/register').send(owner);
    ownerToken = res.body.data.token;
    ownerId = res.body.data.id;

    res = await request(app).post('/api/auth/register').send(intruder);
    intruderToken = res.body.data.token;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'RAG Test Exam' });
    examId = res.body.data.id;

    dbmsDocId = 'rag-dbms-doc';
    osDocId = 'rag-os-doc';

    await prisma.$executeRaw`
      INSERT INTO "Document" ("id", "userId", "examId", "title", "fileName", "filePath", "fileType", "fileSize", "category", "updatedAt")
      VALUES (${dbmsDocId}, ${ownerId}, NULL, 'DBMS Notes', 'dbms.txt', '/tmp/dbms.txt', 'text/plain', 100, 'NOTES', NOW())
    `;
    await prisma.$executeRaw`
      INSERT INTO "Document" ("id", "userId", "examId", "title", "fileName", "filePath", "fileType", "fileSize", "category", "updatedAt")
      VALUES (${osDocId}, ${ownerId}, ${examId}, 'Operating Systems Notes', 'os.txt', '/tmp/os.txt', 'text/plain', 100, 'NOTES', NOW())
    `;

    // Page metadata mirrors what LangChain's PDFLoader attaches per-chunk.
    await insertChunk({
      documentId: dbmsDocId,
      content:
        'Normalization in DBMS is the process of organizing data to reduce redundancy. First Normal Form (1NF) requires atomic column values.',
      metadata: { loc: { pageNumber: 3 } },
    });
    await insertChunk({
      documentId: osDocId,
      content:
        'A deadlock occurs when a set of processes are blocked because each holds a resource and waits for another. The four necessary conditions are mutual exclusion, hold and wait, no preemption, and circular wait.',
      metadata: { loc: { pageNumber: 10 } },
    });
  });

  afterAll(async () => {
    await prisma.documentChunk.deleteMany({ where: { document: { userId: ownerId } } });
    await prisma.document.deleteMany({ where: { userId: ownerId } });
    await prisma.exam.deleteMany({ where: { userId: ownerId } });
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });
    await prisma.$disconnect();
  });

  it('cites the correct source title and page number', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ question: 'What is normalization and what does First Normal Form require?' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.foundInMaterials).toBe(true);
    expect(res.body.data.sources.length).toBeGreaterThan(0);
    expect(res.body.data.sources[0]).toEqual({ title: 'DBMS Notes', page: 3 });
  });

  it('discriminates between similar-but-distinct topics across documents', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ question: 'What are the four necessary conditions for a deadlock?' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.answer).toMatch(/mutual exclusion/i);
    // Should cite the OS document, not the unrelated DBMS one.
    const titles = res.body.data.sources.map((s) => s.title);
    expect(titles).toContain('Operating Systems Notes');
    expect(titles).not.toContain('DBMS Notes');
  });

  it("never retrieves another user's resources, even on an on-topic question", async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ question: 'What is normalization and what does First Normal Form require?' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.foundInMaterials).toBe(false);
    expect(res.body.data.sources).toEqual([]);
  });

  it('does not fabricate a source when nothing relevant exists (empty retrieval)', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ question: 'Explain the plot of Romeo and Juliet.' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.foundInMaterials).toBe(false);
    expect(res.body.data.sources).toEqual([]);
  });

  it('filters retrieval by examId — excludes a real match outside the given exam', async () => {
    // DBMS Notes is NOT linked to `examId` (only OS Notes is), so a
    // normalization question scoped to this exam should find nothing, even
    // though the owner does have relevant content in a different document.
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ question: 'What is normalization?', examId });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.foundInMaterials).toBe(false);
    expect(res.body.data.sources).toEqual([]);
  });

  it('filters retrieval by examId — includes the matching document', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ question: 'What are the four necessary conditions for a deadlock?', examId });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.foundInMaterials).toBe(true);
    expect(res.body.data.sources.map((s) => s.title)).toContain('Operating Systems Notes');
  });

  it('filters retrieval by category', async () => {
    const res = await request(app)
      .post('/api/ai/ask')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ question: 'What is normalization?', category: 'PYQ' });

    // Both docs are category NOTES, so filtering to PYQ should find nothing
    // even though a real NOTES match exists.
    expect(res.statusCode).toBe(200);
    expect(res.body.data.foundInMaterials).toBe(false);
    expect(res.body.data.sources).toEqual([]);
  });
});
