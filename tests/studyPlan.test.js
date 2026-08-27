const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');

describe('Study Plan API (integration)', () => {
  jest.setTimeout(30000);

  const owner = { name: 'Plan Owner', email: 'planowner@test.com', password: 'password123' };
  const intruder = { name: 'Plan Intruder', email: 'planintruder@test.com', password: 'password123' };

  let ownerToken, intruderToken;
  let examId, subjectId, weakTopicId, strongTopicId;
  let ownerUserId;

  const inDays = (n) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  };

  // Direct-Prisma seeding, same as mastery.test.js — a study plan only
  // needs mastery/PYQ data to already exist, not live LLM quiz generation.
  const seedQuizAttempt = async (topicId, correctFlags) => {
    const quiz = await prisma.quiz.create({
      data: {
        userId: ownerUserId,
        subjectId,
        topicId,
        title: 'Seeded quiz',
        difficulty: 'medium',
        questions: {
          create: correctFlags.map((_, i) => ({
            question: `Q${i}`,
            options: ['A', 'B', 'C', 'D'],
            correctAnswer: 'A',
          })),
        },
      },
      include: { questions: true },
    });
    const correctCount = correctFlags.filter(Boolean).length;
    await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId: ownerUserId,
        score: (correctCount / correctFlags.length) * 100,
        totalQuestions: correctFlags.length,
        correctCount,
        completedAt: new Date(),
        answers: {
          create: quiz.questions.map((q, i) => ({
            questionId: q.id,
            selectedAnswer: correctFlags[i] ? 'A' : 'B',
            isCorrect: correctFlags[i],
          })),
        },
      },
    });
  };

  beforeAll(async () => {
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
        name: 'Study Plan Test Exam',
        subjects: [{ name: 'Subject A', topics: [{ name: 'Weak Topic' }, { name: 'Strong Topic' }] }],
      });
    examId = res.body.data.id;
    subjectId = res.body.data.subjects[0].id;
    weakTopicId = res.body.data.subjects[0].topics.find((t) => t.name === 'Weak Topic').id;
    strongTopicId = res.body.data.subjects[0].topics.find((t) => t.name === 'Strong Topic').id;

    await seedQuizAttempt(weakTopicId, [false, false, false, true, false]);
    await seedQuizAttempt(strongTopicId, [true, true, true, true, true]);
  });

  afterAll(async () => {
    await prisma.studyPlanSession.deleteMany({ where: { plan: { userId: ownerUserId } } });
    await prisma.studyPlan.deleteMany({ where: { userId: ownerUserId } });
    await prisma.quizAttempt.deleteMany({ where: { userId: ownerUserId } });
    await prisma.quiz.deleteMany({ where: { userId: ownerUserId } });
    await prisma.exam.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });
    await prisma.$disconnect();
  });

  it('refuses to generate a plan before an exam date is set', async () => {
    const res = await request(app).post(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/exam date/i);
  });

  it('refuses to generate a plan before available hours/day is set', async () => {
    await request(app)
      .patch(`/api/exams/${examId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ examDate: inDays(10) });

    const res = await request(app).post(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(400);
    expect(res.body.message).toMatch(/hours/i);
  });

  it('refuses to generate a plan for an exam date already in the past', async () => {
    const res = await request(app)
      .post(`/api/exams/${examId}/study-plan`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send();
    // Still missing hours at this point in the sequence — set both, then
    // separately verify the past-date guard with a second exam below.
    expect(res.statusCode).toBe(400);
  });

  it('generates and persists a plan once exam date and hours/day are both set', async () => {
    await request(app)
      .patch(`/api/exams/${examId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ availableHoursPerDay: 3 });

    const res = await request(app).post(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(201);
    expect(res.body.data.plan.sessions.length).toBeGreaterThan(0);

    const weakMinutes = res.body.data.plan.sessions
      .filter((s) => s.topicId === weakTopicId)
      .reduce((sum, s) => sum + s.durationMinutes, 0);
    const strongMinutes = res.body.data.plan.sessions
      .filter((s) => s.topicId === strongTopicId)
      .reduce((sum, s) => sum + s.durationMinutes, 0);

    // The weak topic (20% correct) should dominate over the strong,
    // confidently-mastered topic (100% correct, which should be skipped
    // outright once it has enough attempts to be confident).
    expect(weakMinutes).toBeGreaterThan(0);
    expect(strongMinutes).toBe(0);

    // Regression: sessions must carry a resolvable topic name, not just an
    // id, since the plan view spans many topics at once.
    const weakSession = res.body.data.plan.sessions.find((s) => s.topicId === weakTopicId);
    expect(weakSession.topic?.name).toBe('Weak Topic');
  });

  it('fetches the persisted plan', async () => {
    const res = await request(app).get(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).not.toBeNull();
    expect(res.body.data.sessions.length).toBeGreaterThan(0);
  });

  it('toggles a session as completed and back', async () => {
    const planRes = await request(app).get(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    const sessionId = planRes.body.data.sessions[0].id;

    let res = await request(app)
      .patch(`/api/study-plan-sessions/${sessionId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ completed: true });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.completed).toBe(true);
    expect(res.body.data.completedAt).not.toBeNull();

    res = await request(app)
      .patch(`/api/study-plan-sessions/${sessionId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ completed: false });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.completed).toBe(false);
    expect(res.body.data.completedAt).toBeNull();
  });

  it('regenerating replaces the previous plan outright', async () => {
    const before = await request(app).get(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    const beforeSessionIds = before.body.data.sessions.map((s) => s.id).sort();

    const regen = await request(app).post(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    expect(regen.statusCode).toBe(201);

    const after = await request(app).get(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    const afterSessionIds = after.body.data.sessions.map((s) => s.id).sort();

    expect(afterSessionIds).not.toEqual(beforeSessionIds);
    // Exactly one plan row should exist for this (exam, user) — enforced by
    // the unique constraint plus the service's delete-then-create.
    const plans = await prisma.studyPlan.findMany({ where: { examId, userId: ownerUserId } });
    expect(plans.length).toBe(1);
  });

  it("does not let another user generate, view, or complete sessions on this owner's plan", async () => {
    let res = await request(app).post(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);

    res = await request(app).get(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);

    const planRes = await request(app).get(`/api/exams/${examId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    const sessionId = planRes.body.data.sessions[0].id;
    res = await request(app)
      .patch(`/api/study-plan-sessions/${sessionId}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ completed: true });
    expect(res.statusCode).toBe(404);
  });

  it('refuses to generate a plan with no syllabus topics', async () => {
    const res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ name: 'Empty Syllabus Exam', examDate: inDays(5), availableHoursPerDay: 2 });
    const emptyExamId = res.body.data.id;

    const planRes = await request(app).post(`/api/exams/${emptyExamId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    expect(planRes.statusCode).toBe(400);
    expect(planRes.body.message).toMatch(/syllabus|topics/i);
  });

  it('refuses to generate a plan once the exam date has passed', async () => {
    const res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Past Date Exam',
        examDate: inDays(-5),
        availableHoursPerDay: 2,
        subjects: [{ name: 'S', topics: [{ name: 'T' }] }],
      });
    const pastExamId = res.body.data.id;

    const planRes = await request(app).post(`/api/exams/${pastExamId}/study-plan`).set('Authorization', `Bearer ${ownerToken}`);
    expect(planRes.statusCode).toBe(400);
    expect(planRes.body.message).toMatch(/passed/i);
  });
});
