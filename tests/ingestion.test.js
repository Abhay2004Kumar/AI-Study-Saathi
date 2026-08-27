const { buildIngestionGraph } = require('../src/ai/graphs/ingestion.graph');
const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const path = require('path');
const fs = require('fs');

const NOTES_SAMPLE = `
Process Scheduling in Operating Systems

The CPU scheduler is responsible for selecting one process from the ready queue and allocating the CPU to it.
There are several scheduling algorithms: First-Come-First-Served (FCFS) runs processes in arrival order.
Shortest Job First (SJF) picks the process with the smallest execution time. Round Robin gives every process
a fixed time quantum and cycles through the ready queue.

Deadlocks occur when a set of processes are blocked because each process is holding a resource and waiting for
another resource held by another process. The four necessary conditions for deadlock are mutual exclusion,
hold and wait, no preemption, and circular wait.
`;

const PYQ_SAMPLE = `
Previous Year Questions - Operating Systems (2023)

Q1. What is a deadlock? Explain the four necessary conditions for deadlock to occur.

Q2. Differentiate between preemptive and non-preemptive scheduling.
Options: A) Preemptive allows interruption, B) Non-preemptive never interrupts, C) Both A and B, D) None of these
Correct Answer: C) Both A and B

Q3. Define thrashing in the context of virtual memory.
`;

const SYLLABUS_SAMPLE = `
Operating Systems Syllabus

Unit 1: Process Management - process states, scheduling algorithms, context switching
Unit 2: Deadlocks - detection, prevention, avoidance, Banker's algorithm
Unit 3: Memory Management - paging, segmentation, virtual memory, thrashing
`;

const GENERAL_SAMPLE = `
Welcome to campus! Here are the library hours: Monday to Friday 9am-8pm, Saturday 10am-4pm.
The cafeteria menu changes weekly and is posted on the notice board near the main entrance.
`;

describe('Ingestion Graph (unit)', () => {
  it('classifies notes-like content as NOTES and extracts candidate topics', async () => {
    const graph = buildIngestionGraph();
    const result = await graph.invoke({ documentId: 'test-doc', userCategory: 'GENERAL', rawText: NOTES_SAMPLE });

    expect(result.resourceType).toBe('NOTES');
    expect(result.confidence).toBeGreaterThan(0);
    expect(Array.isArray(result.topics)).toBe(true);
    expect(result.topics.length).toBeGreaterThan(0);
    expect(result.topics.some((t) => /schedul|deadlock/i.test(t.name))).toBe(true);
  }, 45000);

  it('classifies a question paper as PYQ and extracts questions without inventing answers', async () => {
    const graph = buildIngestionGraph();
    const result = await graph.invoke({ documentId: 'test-doc', userCategory: 'GENERAL', rawText: PYQ_SAMPLE });

    expect(result.resourceType).toBe('PYQ');
    expect(Array.isArray(result.questions)).toBe(true);
    expect(result.questions.length).toBeGreaterThanOrEqual(2);
    // Q1 and Q3 have no stated answer in the source — the prompt explicitly
    // forbids guessing one, so they should come back without correctAnswer.
    const q1 = result.questions.find((q) => /deadlock/i.test(q.question));
    expect(q1?.correctAnswer).toBeFalsy();
  }, 45000);

  it('classifies a syllabus outline as SYLLABUS and extracts a subject/topic tree', async () => {
    const graph = buildIngestionGraph();
    const result = await graph.invoke({ documentId: 'test-doc', userCategory: 'GENERAL', rawText: SYLLABUS_SAMPLE });

    expect(result.resourceType).toBe('SYLLABUS');
    expect(result.topics).toBeTruthy();
    expect(Array.isArray(result.topics.subjects)).toBe(true);
    expect(result.topics.subjects.length).toBeGreaterThan(0);
  }, 45000);

  it('classifies unrelated content as GENERAL and skips type-specific extraction', async () => {
    const graph = buildIngestionGraph();
    const result = await graph.invoke({ documentId: 'test-doc', userCategory: 'NOTES', rawText: GENERAL_SAMPLE });

    expect(result.resourceType).toBe('GENERAL');
    // The GENERAL branch goes straight to END — no extraction node ran.
    expect(result.topics).toBeNull();
    expect(result.questions).toBeNull();
  }, 45000);
});

describe('Ingestion pipeline (integration via upload)', () => {
  const testUser = {
    name: 'Ingestion Test User',
    email: 'ingestiontest@example.com',
    password: 'password123',
  };
  let token = '';
  const notesFilePath = path.join(__dirname, 'ingestion-notes.txt');

  beforeAll(async () => {
    fs.writeFileSync(notesFilePath, NOTES_SAMPLE);
    await prisma.$connect();
    await prisma.document.deleteMany({ where: { user: { email: testUser.email } } });
    await prisma.user.deleteMany({ where: { email: testUser.email } });

    const res = await request(app).post('/api/auth/register').send(testUser);
    token = res.body.data.token;
  });

  afterAll(async () => {
    if (fs.existsSync(notesFilePath)) fs.unlinkSync(notesFilePath);
    await prisma.document.deleteMany({ where: { user: { email: testUser.email } } });
    await prisma.user.deleteMany({ where: { email: testUser.email } });
    await prisma.$disconnect();
  });

  const waitForReady = async (documentId, timeoutMs = 60000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const doc = await prisma.document.findUnique({ where: { id: documentId } });
      if (doc.processingStatus === 'READY' || doc.processingStatus === 'FAILED') return doc;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`Document ${documentId} did not finish processing within ${timeoutMs}ms`);
  };

  it('runs classification and stores a ResourceExtraction row after a real upload', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${token}`)
      .field('title', 'OS Notes for Ingestion Test')
      .attach('file', notesFilePath);

    expect(uploadRes.statusCode).toBe(201);
    const documentId = uploadRes.body.data.id;

    const finalDoc = await waitForReady(documentId);
    expect(finalDoc.processingStatus).toBe('READY');
    expect(finalDoc.aiCategory).toBe('NOTES');
    expect(finalDoc.classificationConfidence).toBeGreaterThan(0);

    const extraction = await prisma.resourceExtraction.findUnique({ where: { documentId } });
    expect(extraction).toBeTruthy();
    expect(extraction.resourceType).toBe('NOTES');
    expect(Array.isArray(extraction.topics)).toBe(true);
    expect(extraction.topics.length).toBeGreaterThan(0);

    const detailRes = await request(app)
      .get(`/api/documents/${documentId}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detailRes.body.data.extraction).toBeTruthy();
    expect(detailRes.body.data.extraction.resourceType).toBe('NOTES');
  }, 90000);
});
