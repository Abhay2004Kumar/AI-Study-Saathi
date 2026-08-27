const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const fs = require('fs');
const path = require('path');
const TopicMappingService = require('../src/ai/services/topicMapping.service');
const { buildCatalog, validateMappings, CONFIDENCE_THRESHOLD } = TopicMappingService;

describe('Topic mapping validation (unit, no LLM)', () => {
  const subjects = [
    {
      name: 'Operating Systems',
      topics: [
        {
          id: 'topic-deadlocks',
          name: 'Deadlocks',
          subtopics: [{ id: 'subtopic-bankers', name: "Banker's Algorithm" }],
        },
        { id: 'topic-memory', name: 'Memory Management', subtopics: [] },
      ],
    },
  ];

  it('builds a catalog covering every topic and subtopic, case-insensitively keyed', () => {
    const { targetByName } = buildCatalog(subjects);
    expect(targetByName.get('deadlocks')).toEqual({ topicId: 'topic-deadlocks', subtopicId: null });
    expect(targetByName.get("banker's algorithm")).toEqual({ topicId: 'topic-deadlocks', subtopicId: 'subtopic-bankers' });
    expect(targetByName.get('memory management')).toEqual({ topicId: 'topic-memory', subtopicId: null });
  });

  it('accepts a correct mapping and preserves its page range', () => {
    const { targetByName } = buildCatalog(subjects);
    const raw = [{ topicName: 'Deadlocks', startPage: 5, endPage: 12, confidence: 0.9 }];

    const result = validateMappings(raw, targetByName, 'doc-1');

    expect(result).toEqual([
      {
        documentId: 'doc-1',
        topicId: 'topic-deadlocks',
        subtopicId: null,
        startPage: 5,
        endPage: 12,
        confidence: 0.9,
        status: 'CONFIRMED',
      },
    ]);
  });

  it('accepts multiple distinct topics mapped from one resource', () => {
    const { targetByName } = buildCatalog(subjects);
    const raw = [
      { topicName: 'Deadlocks', startPage: 1, endPage: 10, confidence: 0.85 },
      { topicName: 'Memory Management', startPage: 11, endPage: 20, confidence: 0.8 },
    ];

    const result = validateMappings(raw, targetByName, 'doc-1');

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.topicId).sort()).toEqual(['topic-deadlocks', 'topic-memory']);
  });

  it('drops a mapping whose topicName is not a real syllabus node (invalid AI output)', () => {
    const { targetByName } = buildCatalog(subjects);
    const raw = [
      { topicName: 'Deadlocks', startPage: 1, endPage: 5, confidence: 0.9 },
      { topicName: 'Quantum Computing', startPage: 6, endPage: 8, confidence: 0.9 }, // hallucinated, not in syllabus
    ];

    const result = validateMappings(raw, targetByName, 'doc-1');

    expect(result).toHaveLength(1);
    expect(result[0].topicId).toBe('topic-deadlocks');
  });

  it('downgrades a low-confidence mapping to PENDING_REVIEW instead of auto-confirming it', () => {
    const { targetByName } = buildCatalog(subjects);
    const belowThreshold = CONFIDENCE_THRESHOLD - 0.1;
    const raw = [{ topicName: 'Deadlocks', confidence: belowThreshold }];

    const result = validateMappings(raw, targetByName, 'doc-1');

    expect(result[0].status).toBe('PENDING_REVIEW');
  });

  it('resolves a subtopic-level match to its parent topicId plus the subtopicId', () => {
    const { targetByName } = buildCatalog(subjects);
    const raw = [{ topicName: "Banker's Algorithm", confidence: 0.9 }];

    const result = validateMappings(raw, targetByName, 'doc-1');

    expect(result[0]).toMatchObject({ topicId: 'topic-deadlocks', subtopicId: 'subtopic-bankers' });
  });

  it('treats a missing/non-numeric confidence as 0 (PENDING_REVIEW), not a crash', () => {
    const { targetByName } = buildCatalog(subjects);
    const raw = [{ topicName: 'Deadlocks' }];

    const result = validateMappings(raw, targetByName, 'doc-1');

    expect(result[0].confidence).toBe(0);
    expect(result[0].status).toBe('PENDING_REVIEW');
  });
});

describe('Topic mapping API (integration)', () => {
  jest.setTimeout(60000);

  const owner = { name: 'Mapping Owner', email: 'mappingowner@test.com', password: 'password123' };
  const intruder = { name: 'Mapping Intruder', email: 'mappingintruder@test.com', password: 'password123' };

  let ownerToken, intruderToken;
  let examId, deadlocksTopicId;
  let noSyllabusExamId;
  let docAId, docBId;

  const fileA = path.join(__dirname, 'mapping-doc-a.txt');
  const fileB = path.join(__dirname, 'mapping-doc-b.txt');
  const fileC = path.join(__dirname, 'mapping-doc-c.txt');
  const fileD = path.join(__dirname, 'mapping-doc-d.txt');

  const DEADLOCK_CONTENT =
    'Deadlocks: A deadlock occurs when a set of processes are blocked because each process is holding a resource and waiting for another. The four necessary conditions are mutual exclusion, hold and wait, no preemption, and circular wait.';

  beforeAll(async () => {
    fs.writeFileSync(fileA, DEADLOCK_CONTENT);
    fs.writeFileSync(fileB, `Revision notes.\n\n${DEADLOCK_CONTENT}\n\nAlso covers unrelated administrative topics.`);
    fs.writeFileSync(fileC, `${DEADLOCK_CONTENT}\n\n(Uploaded to an exam with no syllabus yet.)`);
    fs.writeFileSync(fileD, `${DEADLOCK_CONTENT}\n\n(Uploaded with no exam linked at all.)`);

    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });

    let res = await request(app).post('/api/auth/register').send(owner);
    ownerToken = res.body.data.token;

    res = await request(app).post('/api/auth/register').send(intruder);
    intruderToken = res.body.data.token;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Mapping Test Exam',
        subjects: [{ name: 'Operating Systems', topics: [{ name: 'Deadlocks' }, { name: 'Memory Management' }] }],
      });
    examId = res.body.data.id;
    deadlocksTopicId = res.body.data.subjects[0].topics.find((t) => t.name === 'Deadlocks').id;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'No Syllabus Exam' });
    noSyllabusExamId = res.body.data.id;
  });

  afterAll(async () => {
    for (const f of [fileA, fileB, fileC, fileD]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    await prisma.resourceTopicMapping.deleteMany({ where: { document: { user: { email: owner.email } } } });
    await prisma.document.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
    await prisma.exam.deleteMany({ where: { user: { email: owner.email } } });
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });
    await prisma.$disconnect();
  });

  const waitForReady = async (documentId, timeoutMs = 45000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const doc = await prisma.document.findUnique({ where: { id: documentId } });
      if (doc.processingStatus === 'READY' || doc.processingStatus === 'FAILED') return doc;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Document ${documentId} did not finish processing in time`);
  };

  it('maps a resource to the correct topic automatically during ingestion, with a page range', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'OS Notes A')
      .field('examId', examId)
      .field('category', 'NOTES')
      .attach('file', fileA);
    docAId = uploadRes.body.data.id;
    await waitForReady(docAId);

    const res = await request(app)
      .get(`/api/documents/${docAId}/mappings`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    const deadlockMapping = res.body.data.find((m) => m.topic?.name === 'Deadlocks');
    expect(deadlockMapping).toBeTruthy();
    expect(['CONFIRMED', 'PENDING_REVIEW']).toContain(deadlockMapping.status);
  });

  it('maps a second, different resource to the same topic (one topic, multiple resources)', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'OS Notes B')
      .field('examId', examId)
      .field('category', 'NOTES')
      .attach('file', fileB);
    docBId = uploadRes.body.data.id;
    await waitForReady(docBId);

    const res = await request(app)
      .get(`/api/exams/${examId}/topics/${deadlocksTopicId}/resources`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.topic.name).toBe('Deadlocks');
    const mappedDocIds = res.body.data.notes.map((m) => m.document.id);
    expect(mappedDocIds).toEqual(expect.arrayContaining([docAId, docBId]));
  });

  it('returns null (nothing to map) when the exam has no syllabus yet', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'No Syllabus Doc')
      .field('examId', noSyllabusExamId)
      .attach('file', fileC);
    expect(uploadRes.statusCode).toBe(201);
    const docId = uploadRes.body.data.id;
    await waitForReady(docId);

    const result = await TopicMappingService.run(docId);
    expect(result).toBeNull();

    const res = await request(app)
      .post(`/api/documents/${docId}/map-topics`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(400);
  });

  it('rejects mapping a document that has no exam linked', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'Unlinked Doc')
      .attach('file', fileD);
    expect(uploadRes.statusCode).toBe(201);
    const docId = uploadRes.body.data.id;
    await waitForReady(docId);

    const res = await request(app)
      .post(`/api/documents/${docId}/map-topics`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(400);
  });

  it("does not let another user browse this exam's topic resources", async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/topics/${deadlocksTopicId}/resources`)
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);
  });

  it("does not let another user view or retrigger mapping for this document", async () => {
    let res = await request(app)
      .get(`/api/documents/${docAId}/mappings`)
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);

    res = await request(app)
      .post(`/api/documents/${docAId}/map-topics`)
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);
  });

  it('lets the owner confirm or reject a mapping (the review mechanism)', async () => {
    const listRes = await request(app)
      .get(`/api/documents/${docAId}/mappings`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const mappingId = listRes.body.data[0].id;

    const rejectRes = await request(app)
      .patch(`/api/mappings/${mappingId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'REJECTED' });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.body.data.status).toBe('REJECTED');

    const intruderRes = await request(app)
      .patch(`/api/mappings/${mappingId}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ status: 'CONFIRMED' });
    expect(intruderRes.statusCode).toBe(404);

    const badStatusRes = await request(app)
      .patch(`/api/mappings/${mappingId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'NOT_A_REAL_STATUS' });
    expect(badStatusRes.statusCode).toBe(400);
  });
});
