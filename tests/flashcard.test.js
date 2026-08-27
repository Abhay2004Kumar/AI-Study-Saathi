const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const fs = require('fs');
const path = require('path');

describe('Flashcard / Revision API (integration)', () => {
  jest.setTimeout(60000);

  const owner = { name: 'Flash Owner', email: 'flashowner@test.com', password: 'password123' };
  const intruder = { name: 'Flash Intruder', email: 'flashintruder@test.com', password: 'password123' };

  let ownerToken, intruderToken, ownerUserId;
  let examId, subjectId, weakTopicId;
  let emptyExamId, emptyTopicId;
  let dueCardId, futureCardId;

  const notesFile = path.join(__dirname, 'flashcard-notes.txt');
  const NOTES_CONTENT = `Process Scheduling Notes

The CPU scheduler selects from among the processes in memory that are ready to execute and allocates the CPU to one of them.
Short-term scheduling happens very frequently and must be fast.
Round Robin scheduling assigns a fixed time slice, called a quantum, to each process in a cyclic order.
First Come First Served (FCFS) is the simplest scheduling algorithm, running processes in arrival order.`;

  beforeAll(async () => {
    fs.writeFileSync(notesFile, NOTES_CONTENT);
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });

    let res = await request(app).post('/api/auth/register').send(owner);
    ownerToken = res.body.data.token;
    ownerUserId = res.body.data.id;

    res = await request(app).post('/api/auth/register').send(intruder);
    intruderToken = res.body.data.token;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Flashcard Test Exam',
        subjects: [{ name: 'Operating Systems', topics: [{ name: 'Weak Topic' }] }],
      });
    examId = res.body.data.id;
    subjectId = res.body.data.subjects[0].id;
    weakTopicId = res.body.data.subjects[0].topics[0].id;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Empty Flashcard Exam', subjects: [{ name: 'S', topics: [{ name: 'Untouched Topic' }] }] });
    emptyExamId = res.body.data.id;
    emptyTopicId = res.body.data.subjects[0].topics[0].id;

    const dueCard = await prisma.flashcard.create({
      data: {
        userId: ownerUserId,
        subjectId,
        topicId: weakTopicId,
        front: 'What is FCFS?',
        back: 'First Come First Served — simplest scheduling algorithm.',
        normalizedFront: 'what is fcfs?',
        dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // due yesterday
      },
    });
    dueCardId = dueCard.id;

    const futureCard = await prisma.flashcard.create({
      data: {
        userId: ownerUserId,
        subjectId,
        topicId: weakTopicId,
        front: 'What is a quantum?',
        back: 'The fixed time slice assigned to each process in Round Robin scheduling.',
        normalizedFront: 'what is a quantum?',
        dueAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000), // due in 5 days
      },
    });
    futureCardId = futureCard.id;
  });

  afterAll(async () => {
    if (fs.existsSync(notesFile)) fs.unlinkSync(notesFile);
    await prisma.flashcard.deleteMany({ where: { userId: ownerUserId } });
    await prisma.document.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
    await prisma.exam.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });
    await prisma.$disconnect();
  });

  it('lists all flashcards for a topic regardless of due status', async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/topics/${weakTopicId}/flashcards`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.length).toBe(2);
  });

  it('returns only cards due now across the exam, soonest first', async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/flashcards/due`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((c) => c.id)).toEqual([dueCardId]);
  });

  it('grades a review with GOOD and reschedules the card into the future', async () => {
    const res = await request(app)
      .post(`/api/flashcards/${dueCardId}/review`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ grade: 'GOOD' });

    expect(res.statusCode).toBe(200);
    expect(res.body.data.repetitions).toBe(1);
    expect(res.body.data.intervalDays).toBe(1);
    expect(new Date(res.body.data.dueAt).getTime()).toBeGreaterThan(Date.now());
    expect(res.body.data.lastReviewedAt).not.toBeNull();
  });

  it('no longer shows the just-reviewed card in the due list', async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/flashcards/due`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.body.data.find((c) => c.id === dueCardId)).toBeUndefined();
  });

  it('resets progress on an AGAIN grade even after prior successful reviews', async () => {
    // Fast-forward the card into the past again so it's reviewable, then grade AGAIN.
    await prisma.flashcard.update({ where: { id: dueCardId }, data: { dueAt: new Date(Date.now() - 1000) } });
    const res = await request(app)
      .post(`/api/flashcards/${dueCardId}/review`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ grade: 'AGAIN' });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.repetitions).toBe(0);
    expect(res.body.data.intervalDays).toBe(1);
  });

  it('rejects an invalid grade', async () => {
    const res = await request(app)
      .post(`/api/flashcards/${dueCardId}/review`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ grade: 'KINDA' });
    expect(res.statusCode).toBe(400);
  });

  it("does not let another user list, review, or see this owner's due cards", async () => {
    let res = await request(app)
      .get(`/api/exams/${examId}/topics/${weakTopicId}/flashcards`)
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);

    res = await request(app).get(`/api/exams/${examId}/flashcards/due`).set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);

    res = await request(app)
      .post(`/api/flashcards/${futureCardId}/review`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ grade: 'GOOD' });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to generate flashcards for a topic with no material at all', async () => {
    const res = await request(app)
      .post(`/api/exams/${emptyExamId}/topics/${emptyTopicId}/flashcards`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ numberOfCards: 5 });
    expect(res.statusCode).toBe(400);
  });

  it('generates new flashcards from uploaded notes, additively, without disturbing existing cards', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'Scheduling Notes')
      .field('examId', examId)
      .field('category', 'NOTES')
      .attach('file', notesFile);
    const docId = uploadRes.body.data.id;

    const waitForReady = async (documentId, timeoutMs = 45000) => {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        const doc = await prisma.document.findUnique({ where: { id: documentId } });
        if (doc.processingStatus === 'READY' || doc.processingStatus === 'FAILED') return doc;
        await new Promise((r) => setTimeout(r, 500));
      }
      throw new Error(`Document ${documentId} did not finish processing in time`);
    };
    await waitForReady(docId);

    const before = await prisma.flashcard.count({ where: { topicId: weakTopicId } });

    const res = await request(app)
      .post(`/api/exams/${examId}/topics/${weakTopicId}/flashcards`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ numberOfCards: 3 });

    expect(res.statusCode).toBe(201);
    res.body.data.forEach((c) => {
      expect(c).toHaveProperty('front');
      expect(c).toHaveProperty('back');
      expect(c.repetitions).toBe(0);
    });

    const after = await prisma.flashcard.count({ where: { topicId: weakTopicId } });
    expect(after).toBeGreaterThan(before); // additive, never replaced

    // The two pre-seeded cards are still present, untouched.
    const stillThere = await prisma.flashcard.findMany({ where: { id: { in: [dueCardId, futureCardId] } } });
    expect(stillThere.length).toBe(2);
  }, 60000); // full document pipeline (classify/extract/map/embed) + generation, not just one LLM call
});
