const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const fs = require('fs');
const path = require('path');

describe('Quiz Engine API (integration)', () => {
  jest.setTimeout(60000);

  const owner = { name: 'Quiz Owner', email: 'quizowner@test.com', password: 'password123' };
  const intruder = { name: 'Quiz Intruder', email: 'quizintruder@test.com', password: 'password123' };

  let ownerToken, intruderToken;
  let examId, normalizationTopicId;
  let emptyExamId, emptyTopicId;
  let notesDocId;
  let quizId;

  const notesFile = path.join(__dirname, 'quiz-notes.txt');
  const NOTES_CONTENT = `Database Normalization Notes

First Normal Form (1NF) requires that all attributes contain only atomic values and that there are no repeating groups within a table.
Second Normal Form (2NF) requires that the table is already in 1NF and that there is no partial dependency of any column on the primary key.
Third Normal Form (3NF) requires that the table is already in 2NF and that there is no transitive dependency between non-key attributes.
A primary key is a column or set of columns that uniquely identifies each row in a table.
Normalization exists to reduce data redundancy and improve data integrity.`;

  beforeAll(async () => {
    fs.writeFileSync(notesFile, NOTES_CONTENT);
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });

    let res = await request(app).post('/api/auth/register').send(owner);
    ownerToken = res.body.data.token;

    res = await request(app).post('/api/auth/register').send(intruder);
    intruderToken = res.body.data.token;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Quiz Test Exam',
        subjects: [{ name: 'Databases', topics: [{ name: 'Normalization' }] }],
      });
    examId = res.body.data.id;
    normalizationTopicId = res.body.data.subjects[0].topics.find((t) => t.name === 'Normalization').id;

    // A second, empty exam (no resources at all) to exercise the
    // "nothing to generate from" path.
    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Empty Quiz Exam',
        subjects: [{ name: 'Nothing Uploaded', topics: [{ name: 'Untouched Topic' }] }],
      });
    emptyExamId = res.body.data.id;
    emptyTopicId = res.body.data.subjects[0].topics.find((t) => t.name === 'Untouched Topic').id;
  });

  afterAll(async () => {
    if (fs.existsSync(notesFile)) fs.unlinkSync(notesFile);
    await prisma.quizAttempt.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
    await prisma.quiz.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
    await prisma.document.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
    await prisma.exam.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
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

  it('uploads and processes the notes document used to generate a quiz', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'Normalization Notes')
      .field('examId', examId)
      .field('category', 'NOTES')
      .attach('file', notesFile);
    notesDocId = uploadRes.body.data.id;
    const doc = await waitForReady(notesDocId);
    expect(doc.processingStatus).toBe('READY');
  });

  it('rejects an invalid difficulty', async () => {
    const res = await request(app)
      .post(`/api/exams/${examId}/topics/${normalizationTopicId}/quizzes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ difficulty: 'impossible' });
    expect(res.statusCode).toBe(400);
  });

  it('refuses to generate a quiz for a topic with no material at all', async () => {
    const res = await request(app)
      .post(`/api/exams/${emptyExamId}/topics/${emptyTopicId}/quizzes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ numberOfQuestions: 3 });
    expect(res.statusCode).toBe(400);
  });

  it('generates and persists a topic-scoped quiz, without leaking answers to the client', async () => {
    const res = await request(app)
      .post(`/api/exams/${examId}/topics/${normalizationTopicId}/quizzes`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ numberOfQuestions: 3, difficulty: 'easy' });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.topicId).toBe(normalizationTopicId);
    expect(res.body.data.questions.length).toBeGreaterThan(0);
    expect(res.body.data.questions.length).toBeLessThanOrEqual(3);
    res.body.data.questions.forEach((q) => {
      expect(q).toHaveProperty('question');
      expect(q).toHaveProperty('options');
      expect(q.options.length).toBe(4);
      expect(q).not.toHaveProperty('correctAnswer');
      expect(q).not.toHaveProperty('explanation');
    });
    // Generated from the uploaded notes, not conjured from nowhere.
    expect(res.body.data.sourceDocumentIds).toContain(notesDocId);

    quizId = res.body.data.id;
  }, 30000);

  it('lists the generated quiz under the topic, including a null lastAttempt before any submission', async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/topics/${normalizationTopicId}/quizzes`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    const listed = res.body.data.find((q) => q.id === quizId);
    expect(listed).toBeTruthy();
    expect(listed.lastAttempt).toBeNull();
  });

  it('fetches the quiz for taking, still without answers', async () => {
    const res = await request(app)
      .get(`/api/quizzes/${quizId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    res.body.data.questions.forEach((q) => expect(q).not.toHaveProperty('correctAnswer'));
  });

  it("does not let another user generate, view, or submit against this owner's quiz", async () => {
    let res = await request(app)
      .post(`/api/exams/${examId}/topics/${normalizationTopicId}/quizzes`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ numberOfQuestions: 2 });
    expect(res.statusCode).toBe(404);

    res = await request(app).get(`/api/quizzes/${quizId}`).set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);

    res = await request(app)
      .post(`/api/quizzes/${quizId}/submit`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ answers: [] });
    expect(res.statusCode).toBe(404);
  });

  it('grades a fully-correct submission deterministically as 100%', async () => {
    const questions = await prisma.quizQuestion.findMany({ where: { quizId } });
    const answers = questions.map((q) => ({ questionId: q.id, selectedAnswer: q.correctAnswer }));

    const res = await request(app)
      .post(`/api/quizzes/${quizId}/submit`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ answers });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.score).toBe(100);
    expect(res.body.data.correctCount).toBe(questions.length);
    expect(res.body.data.totalQuestions).toBe(questions.length);
    res.body.data.answers.forEach((a) => {
      expect(a.isCorrect).toBe(true);
      expect(a).toHaveProperty('correctAnswer'); // revealed post-submission
      expect(a).toHaveProperty('explanation');
    });
  });

  it('grades a partially-wrong, partially-skipped submission with an exact score', async () => {
    const questions = await prisma.quizQuestion.findMany({ where: { quizId }, orderBy: { id: 'asc' } });
    const answers = questions.map((q, i) => {
      if (i === 0) {
        // deliberately wrong: any option that isn't the correct one
        const wrong = q.options.find((o) => o !== q.correctAnswer);
        return { questionId: q.id, selectedAnswer: wrong };
      }
      if (i === 1) return { questionId: q.id, selectedAnswer: null }; // skipped
      return { questionId: q.id, selectedAnswer: q.correctAnswer };
    });

    const res = await request(app)
      .post(`/api/quizzes/${quizId}/submit`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ answers });

    expect(res.statusCode).toBe(201);
    const expectedCorrect = questions.length - Math.min(2, questions.length);
    expect(res.body.data.correctCount).toBe(Math.max(0, expectedCorrect));
    expect(res.body.data.score).toBeCloseTo((res.body.data.correctCount / questions.length) * 100, 1);

    const first = res.body.data.answers.find((a) => a.questionId === questions[0].id);
    expect(first.isCorrect).toBe(false);
  });

  it("lists attempts and fetches one attempt's full breakdown", async () => {
    const listRes = await request(app)
      .get(`/api/quizzes/${quizId}/attempts`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(listRes.statusCode).toBe(200);
    expect(listRes.body.data.length).toBe(2); // the two submissions above

    const attemptId = listRes.body.data[0].id;
    const detailRes = await request(app)
      .get(`/api/quizzes/${quizId}/attempts/${attemptId}`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.body.data.id).toBe(attemptId);
    expect(Array.isArray(detailRes.body.data.answers)).toBe(true);
  });

  it("now shows the topic's quiz list with a lastAttempt score", async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/topics/${normalizationTopicId}/quizzes`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const listed = res.body.data.find((q) => q.id === quizId);
    expect(listed.lastAttempt).not.toBeNull();
    expect(typeof listed.lastAttempt.score).toBe('number');
  });
});
