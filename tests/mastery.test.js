const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const { computeTopicMastery } = require('../src/services/masteryScoring.service');

describe('Mastery scoring (unit, deterministic, no AI/DB)', () => {
  const NOW = new Date('2026-08-26T00:00:00Z').getTime();
  const DAY = 24 * 60 * 60 * 1000;

  it('returns NOT_STARTED with no attempts', () => {
    expect(computeTopicMastery([], NOW)).toEqual({
      score: 0,
      level: 'NOT_STARTED',
      accuracy: 0,
      attemptCount: 0,
      lowConfidence: true,
    });
  });

  it('scores WEAK for mostly-incorrect recent answers', () => {
    const answers = [
      { isCorrect: false, completedAt: NOW },
      { isCorrect: false, completedAt: NOW },
      { isCorrect: true, completedAt: NOW },
      { isCorrect: false, completedAt: NOW },
    ];
    const result = computeTopicMastery(answers, NOW);
    expect(result.level).toBe('WEAK');
    expect(result.accuracy).toBe(0.25);
    expect(result.attemptCount).toBe(4);
  });

  it('scores STRONG for all-correct recent answers', () => {
    const answers = Array.from({ length: 5 }, () => ({ isCorrect: true, completedAt: NOW }));
    const result = computeTopicMastery(answers, NOW);
    expect(result.level).toBe('STRONG');
    expect(result.score).toBe(1);
  });

  it('weighs a recent correct answer more than an old incorrect one (recency decay)', () => {
    const oldWrong = { isCorrect: false, completedAt: NOW - 90 * DAY };
    const recentCorrect = { isCorrect: true, completedAt: NOW };
    const result = computeTopicMastery([oldWrong, recentCorrect], NOW, { recencyHalfLifeDays: 21 });
    // Unweighted accuracy would be exactly 0.5; recency weighting should push
    // the score above that because the correct answer is much more recent.
    expect(result.accuracy).toBe(0.5);
    expect(result.score).toBeGreaterThan(0.5);
  });

  it('flags lowConfidence below the configured minimum attempt count', () => {
    const result = computeTopicMastery([{ isCorrect: true, completedAt: NOW }], NOW, { minAttemptsForConfidence: 3 });
    expect(result.lowConfidence).toBe(true);
  });

  it('never reports mastery as a probability — only a bounded 0-1 relative signal', () => {
    const answers = Array.from({ length: 6 }, () => ({ isCorrect: true, completedAt: NOW }));
    const result = computeTopicMastery(answers, NOW);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(['NOT_STARTED', 'WEAK', 'DEVELOPING', 'STRONG']).toContain(result.level);
  });
});

describe('Mastery API (integration)', () => {
  jest.setTimeout(30000);

  const owner = { name: 'Mastery Owner', email: 'masteryowner@test.com', password: 'password123' };
  const intruder = { name: 'Mastery Intruder', email: 'masteryintruder@test.com', password: 'password123' };

  let ownerToken, intruderToken;
  let examId, weakTopicId, strongTopicId, untouchedTopicId, subjectId;

  // Seeds a Quiz + QuizQuestions + one graded QuizAttempt directly via
  // Prisma — mastery only needs to read QuizAttemptAnswer history, so this
  // exercises the scoring/aggregation logic without depending on live LLM
  // quiz generation (a separate concern, covered in quiz.test.js).
  const seedAttempt = async (topicId, correctFlags) => {
    const quiz = await prisma.quiz.create({
      data: {
        userId: (await prisma.user.findUnique({ where: { email: owner.email } })).id,
        subjectId,
        topicId,
        title: 'Seeded quiz',
        difficulty: 'medium',
        questions: {
          create: correctFlags.map((_, i) => ({
            question: `Q${i}`,
            options: ['A', 'B', 'C', 'D'],
            correctAnswer: 'A',
            difficulty: 'medium',
          })),
        },
      },
      include: { questions: true },
    });

    const userId = quiz.userId;
    const correctCount = correctFlags.filter(Boolean).length;
    await prisma.quizAttempt.create({
      data: {
        quizId: quiz.id,
        userId,
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
    return quiz.id;
  };

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });

    let res = await request(app).post('/api/auth/register').send(owner);
    ownerToken = res.body.data.token;

    res = await request(app).post('/api/auth/register').send(intruder);
    intruderToken = res.body.data.token;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'Mastery Test Exam',
        subjects: [
          {
            name: 'Subject A',
            topics: [{ name: 'Weak Topic' }, { name: 'Strong Topic' }, { name: 'Untouched Topic' }],
          },
        ],
      });
    examId = res.body.data.id;
    subjectId = res.body.data.subjects[0].id;
    const topics = res.body.data.subjects[0].topics;
    weakTopicId = topics.find((t) => t.name === 'Weak Topic').id;
    strongTopicId = topics.find((t) => t.name === 'Strong Topic').id;
    untouchedTopicId = topics.find((t) => t.name === 'Untouched Topic').id;

    await seedAttempt(weakTopicId, [false, false, true, false, false]); // 20% correct
    await seedAttempt(strongTopicId, [true, true, true, true, true]); // 100% correct
  });

  afterAll(async () => {
    await prisma.quizAttempt.deleteMany({ where: { user: { email: owner.email } } });
    await prisma.quiz.deleteMany({ where: { user: { email: owner.email } } });
    await prisma.exam.deleteMany({ where: { user: { email: { in: [owner.email, intruder.email] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });
    await prisma.$disconnect();
  });

  it("computes WEAK mastery for a topic where the student mostly answers incorrectly", async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/topics/${weakTopicId}/mastery`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.mastery.level).toBe('WEAK');
    expect(res.body.data.mastery.attemptCount).toBe(5);
  });

  it('computes STRONG mastery for a topic answered entirely correctly', async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/topics/${strongTopicId}/mastery`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.mastery.level).toBe('STRONG');
  });

  it('reports NOT_STARTED for a topic with no quiz attempts', async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/topics/${untouchedTopicId}/mastery`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.mastery.level).toBe('NOT_STARTED');
    expect(res.body.data.mastery.attemptCount).toBe(0);
  });

  it('lists all topics under the exam, weakest first', async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/mastery`)
      .set('Authorization', `Bearer ${ownerToken}`);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.length).toBe(3);

    const scoreOf = (topicId) => res.body.data.find((t) => t.topic.id === topicId).mastery.score;
    expect(scoreOf(weakTopicId)).toBeLessThan(scoreOf(strongTopicId));
  });

  it("does not let another user read this owner's mastery data", async () => {
    let res = await request(app)
      .get(`/api/exams/${examId}/mastery`)
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);

    res = await request(app)
      .get(`/api/exams/${examId}/topics/${weakTopicId}/mastery`)
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);
  });
});
