const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const { buildTools } = require('../src/ai/graphs/studyAssistant.graph');

describe('Study Assistant tools (unit-ish, direct-invoked, no LLM)', () => {
  jest.setTimeout(60000);

  const owner = { name: 'Assistant Owner', email: 'assistantowner@test.com', password: 'password123' };

  let ownerUserId, ownerToken;
  let examAId, subjectAId, weakTopicAId;
  let examBId; // a second exam the tools must never leak into or out of

  const findTool = (tools, name) => tools.find((t) => t.name === name);

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: owner.email } });

    const res = await request(app).post('/api/auth/register').send(owner);
    ownerUserId = res.body.data.id;
    ownerToken = res.body.data.token;

    let examRes = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Assistant Test Exam A',
        subjects: [{ name: 'Subject A', topics: [{ name: 'Weak Topic' }] }],
      });
    examAId = examRes.body.data.id;
    subjectAId = examRes.body.data.subjects[0].id;
    weakTopicAId = examRes.body.data.subjects[0].topics[0].id;

    examRes = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Assistant Test Exam B', subjects: [{ name: 'Subject B', topics: [{ name: 'Other Topic' }] }] });
    examBId = examRes.body.data.id;

    // Seed quiz-attempt history directly (mastery), a PyqQuestion (importance),
    // and a study plan session (today's plan) — no live LLM calls needed for
    // any of this, mirroring mastery.test.js / studyPlan.test.js.
    const quiz = await prisma.quiz.create({
      data: {
        userId: ownerUserId,
        subjectId: subjectAId,
        topicId: weakTopicAId,
        title: 'Seeded quiz',
        difficulty: 'medium',
        questions: {
          create: [
            { question: 'Q1', options: ['A', 'B', 'C', 'D'], correctAnswer: 'A' },
            { question: 'Q2', options: ['A', 'B', 'C', 'D'], correctAnswer: 'A' },
          ],
        },
      },
      include: { questions: true },
    });
    await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: ownerUserId,
        score: 0,
        totalQuestions: 2,
        correctCount: 0,
        completedAt: new Date(),
        answers: {
          create: quiz.questions.map((q) => ({ questionId: q.id, selectedAnswer: 'B', isCorrect: false })),
        },
      },
    });

    const doc = await prisma.document.create({
      data: {
        userId: ownerUserId,
        examId: examAId,
        title: 'PYQ doc',
        fileName: 'pyq.txt',
        filePath: '/dummy/pyq.txt',
        fileType: 'text/plain',
        fileSize: 10,
        processingStatus: 'READY',
      },
    });
    await prisma.pyqQuestion.create({
      data: {
        documentId: doc.id,
        topicId: weakTopicAId,
        questionText: 'Sample past question',
        normalizedText: 'sample past question',
        year: 2023,
        status: 'CONFIRMED',
      },
    });

    const plan = await prisma.studyPlan.create({
      data: {
        examId: examAId,
        userId: ownerUserId,
        startDate: new Date(),
        endDate: new Date(),
        sessions: {
          create: [
            {
              date: new Date(),
              topicId: weakTopicAId,
              durationMinutes: 30,
              priorityScore: 0.8,
              reason: 'Weak area — needs focused practice',
            },
          ],
        },
      },
    });
    expect(plan.id).toBeTruthy();

    await prisma.flashcard.create({
      data: {
        userId: ownerUserId,
        subjectId: subjectAId,
        topicId: weakTopicAId,
        front: 'Due card',
        back: 'Answer',
        normalizedFront: 'due card',
        dueAt: new Date(Date.now() - 1000),
      },
    });
  });

  afterAll(async () => {
    await prisma.flashcard.deleteMany({ where: { userId: ownerUserId } });
    await prisma.studyPlanSession.deleteMany({ where: { plan: { userId: ownerUserId } } });
    await prisma.studyPlan.deleteMany({ where: { userId: ownerUserId } });
    await prisma.pyqQuestion.deleteMany({ where: { document: { userId: ownerUserId } } });
    await prisma.quizAttempt.deleteMany({ where: { userId: ownerUserId } });
    await prisma.quiz.deleteMany({ where: { userId: ownerUserId } });
    await prisma.document.deleteMany({ where: { userId: ownerUserId } });
    await prisma.assistantSession.deleteMany({ where: { userId: ownerUserId } });
    await prisma.exam.deleteMany({ where: { userId: ownerUserId } });
    await prisma.user.deleteMany({ where: { id: ownerUserId } });
    await prisma.$disconnect();
  });

  it('get_mastery_overview reports this exam\'s real, seeded WEAK topic', async () => {
    const tools = buildTools(ownerUserId, examAId);
    const raw = await findTool(tools, 'get_mastery_overview').invoke({});
    const data = JSON.parse(raw);
    expect(data).toEqual([expect.objectContaining({ topic: 'Weak Topic', level: 'WEAK' })]);
  });

  it("get_mastery_overview scoped to exam B sees no topics from exam A's data", async () => {
    const tools = buildTools(ownerUserId, examBId);
    const raw = await findTool(tools, 'get_mastery_overview').invoke({});
    const data = JSON.parse(raw);
    expect(data).toEqual([expect.objectContaining({ topic: 'Other Topic', level: 'NOT_STARTED' })]);
  });

  it('get_topic_pyq_importance resolves a topic name case-insensitively', async () => {
    const tools = buildTools(ownerUserId, examAId);
    const raw = await findTool(tools, 'get_topic_pyq_importance').invoke({ topicName: 'weak topic' });
    const data = JSON.parse(raw);
    expect(data.topic).toBe('Weak Topic');
    expect(data.yearsSeen).toContain(2023);
  });

  it('get_topic_pyq_importance never trusts a hallucinated topic name — reports not-found instead of guessing', async () => {
    const tools = buildTools(ownerUserId, examAId);
    const raw = await findTool(tools, 'get_topic_pyq_importance').invoke({ topicName: 'Quantum Networking' });
    expect(raw).toMatch(/no topic named/i);
  });

  it("get_topic_pyq_importance scoped to exam B cannot see exam A's topic even by exact name", async () => {
    const tools = buildTools(ownerUserId, examBId);
    const raw = await findTool(tools, 'get_topic_pyq_importance').invoke({ topicName: 'Weak Topic' });
    expect(raw).toMatch(/no topic named/i);
  });

  it("get_todays_study_plan reports today's seeded session", async () => {
    const tools = buildTools(ownerUserId, examAId);
    const raw = await findTool(tools, 'get_todays_study_plan').invoke({});
    const data = JSON.parse(raw);
    expect(data).toEqual([expect.objectContaining({ topic: 'Weak Topic', minutes: 30 })]);
  });

  it('get_todays_study_plan reports no plan for an exam that never generated one', async () => {
    const tools = buildTools(ownerUserId, examBId);
    const raw = await findTool(tools, 'get_todays_study_plan').invoke({});
    expect(raw).toMatch(/no study plan/i);
  });

  it('get_due_flashcard_count reflects the seeded due card', async () => {
    const tools = buildTools(ownerUserId, examAId);
    const raw = await findTool(tools, 'get_due_flashcard_count').invoke({});
    expect(raw).toMatch(/^1 flashcard/);
  });

  it('answers a real conversation by actually calling get_mastery_overview, grounded in the seeded WEAK topic, and persists both turns', async () => {
    const res = await request(app)
      .post(`/api/exams/${examAId}/assistant/message`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ message: 'How am I doing on Weak Topic? What is my mastery level for it?' });

    expect(res.statusCode).toBe(201);
    expect(res.body.data.toolsUsed).toContain('get_mastery_overview');
    expect(res.body.data.reply.toLowerCase()).toMatch(/weak/);
    // The rendering surface is plain RN <Text> — no math/markdown support.
    expect(res.body.data.reply).not.toMatch(/\$[^$]+\$|\\rightarrow|\\ge\b|\\le\b/);

    const session = await prisma.assistantSession.findUnique({ where: { examId_userId: { examId: examAId, userId: ownerUserId } } });
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0]).toMatchObject({ role: 'user' });
    expect(session.messages[1]).toMatchObject({ role: 'assistant' });
  }, 45000);
});

describe('Study Assistant API ownership (integration, no LLM required)', () => {
  jest.setTimeout(30000);

  const owner = { name: 'Assistant API Owner', email: 'assistantapiowner@test.com', password: 'password123' };
  const intruder = { name: 'Assistant API Intruder', email: 'assistantapiintruder@test.com', password: 'password123' };

  let ownerToken, intruderToken, examId;

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });

    let res = await request(app).post('/api/auth/register').send(owner);
    ownerToken = res.body.data.token;

    res = await request(app).post('/api/auth/register').send(intruder);
    intruderToken = res.body.data.token;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Assistant Ownership Exam' });
    examId = res.body.data.id;
  });

  afterAll(async () => {
    await prisma.assistantSession.deleteMany({ where: { exam: { name: 'Assistant Ownership Exam' } } });
    await prisma.exam.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });
    await prisma.$disconnect();
  });

  it('returns no session (not an error) for an exam the owner has not chatted with yet', async () => {
    const res = await request(app).get(`/api/exams/${examId}/assistant`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toBeNull();
  });

  it('rejects an empty message', async () => {
    const res = await request(app)
      .post(`/api/exams/${examId}/assistant/message`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ message: '   ' });
    expect(res.statusCode).toBe(400);
  });

  it("does not let another user read or message this owner's assistant session", async () => {
    let res = await request(app).get(`/api/exams/${examId}/assistant`).set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);

    res = await request(app)
      .post(`/api/exams/${examId}/assistant/message`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ message: 'What should I study?' });
    expect(res.statusCode).toBe(404);
  });
});
