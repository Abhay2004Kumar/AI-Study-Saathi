const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const fs = require('fs');
const path = require('path');
const PyqIntelligenceService = require('../src/ai/services/pyqIntelligence.service');
const { dedupeQuestions, parseYear, validateQuestionMappings } = PyqIntelligenceService;
const { computeTopicFrequency } = require('../src/services/pyqFrequency.service');
const TopicMappingService = require('../src/ai/services/topicMapping.service');

describe('PYQ question helpers (unit, no LLM)', () => {
  describe('dedupeQuestions', () => {
    it('removes exact duplicate questions, case/whitespace-insensitively, keeping the first', () => {
      const raw = [
        { question: 'What is a deadlock?', year: '2021' },
        { question: '  what IS a deadlock?  ', year: '2022' }, // same question, different formatting/year
        { question: 'What is thrashing?', year: '2021' },
      ];

      const result = dedupeQuestions(raw);

      expect(result).toHaveLength(2);
      expect(result[0].year).toBe('2021'); // first occurrence kept
      expect(result.map((q) => q.question)).toEqual(['What is a deadlock?', 'What is thrashing?']);
    });

    it('drops empty/blank questions', () => {
      const result = dedupeQuestions([{ question: '' }, { question: '   ' }, { question: 'Real question' }]);
      expect(result).toHaveLength(1);
    });

    it('returns an empty array for empty input', () => {
      expect(dedupeQuestions([])).toEqual([]);
      expect(dedupeQuestions(undefined)).toEqual([]);
    });
  });

  describe('parseYear (year tracking)', () => {
    it('extracts a 4-digit year from various formats without guessing', () => {
      expect(parseYear('2021')).toBe(2021);
      expect(parseYear('2021-22')).toBe(2021);
      expect(parseYear('Dec 2023')).toBe(2023);
      expect(parseYear('Session 2019')).toBe(2019);
    });

    it('returns null when no year is stated, rather than inventing one', () => {
      expect(parseYear(undefined)).toBeNull();
      expect(parseYear('')).toBeNull();
      expect(parseYear('unknown')).toBeNull();
      expect(parseYear('Question 12')).toBeNull(); // no 19xx/20xx pattern
    });
  });

  describe('validateQuestionMappings (incorrect AI classification)', () => {
    const targetByName = new Map([
      ['deadlocks', { topicId: 'topic-deadlocks', subtopicId: null }],
      ['memory management', { topicId: 'topic-memory', subtopicId: null }],
    ]);

    it('accepts a mapping whose topicName is a real syllabus node', () => {
      const result = validateQuestionMappings(
        [{ questionLabel: 'Q1', topicName: 'Deadlocks', confidence: 0.9 }],
        targetByName
      );
      expect(result.get('Q1')).toMatchObject({ topicId: 'topic-deadlocks', status: 'CONFIRMED' });
    });

    it('drops a mapping whose topicName the model invented (not in the syllabus)', () => {
      const result = validateQuestionMappings(
        [
          { questionLabel: 'Q1', topicName: 'Deadlocks', confidence: 0.9 },
          { questionLabel: 'Q2', topicName: 'Quantum Networking', confidence: 0.95 }, // hallucinated
        ],
        targetByName
      );
      expect(result.has('Q1')).toBe(true);
      expect(result.has('Q2')).toBe(false);
    });

    it('downgrades a low-confidence mapping to PENDING_REVIEW', () => {
      const result = validateQuestionMappings(
        [{ questionLabel: 'Q1', topicName: 'Deadlocks', confidence: 0.2 }],
        targetByName
      );
      expect(result.get('Q1').status).toBe('PENDING_REVIEW');
    });

    it('assigns a single topic even for a mixed-topic-sounding question (one label, one entry)', () => {
      // The model is instructed to pick ONE primary topic; validation just
      // needs to confirm exactly one mapping survives per label even when
      // the underlying question could plausibly touch multiple areas.
      const result = validateQuestionMappings(
        [{ questionLabel: 'Q1', topicName: 'Memory Management', confidence: 0.7 }],
        targetByName
      );
      expect(result.size).toBe(1);
      expect(result.get('Q1').topicId).toBe('topic-memory');
    });
  });
});

describe('PYQ topic frequency scoring (unit, deterministic)', () => {
  const CURRENT_YEAR = 2025;

  it('returns NONE/0 for a topic with no questions', () => {
    const result = computeTopicFrequency([], CURRENT_YEAR);
    expect(result).toEqual({ score: 0, level: 'NONE', yearsSeen: [], questionCount: 0 });
  });

  it('scores HIGH for a topic appearing across many recent years', () => {
    const questions = [{ year: 2025 }, { year: 2024 }, { year: 2023 }, { year: 2022 }, { year: 2021 }];
    const result = computeTopicFrequency(questions, CURRENT_YEAR);
    expect(result.level).toBe('HIGH');
    expect(result.yearsSeen).toEqual([2021, 2022, 2023, 2024, 2025]);
  });

  it('scores lower for a single appearance long ago than a single recent appearance', () => {
    const old = computeTopicFrequency([{ year: 2010 }], CURRENT_YEAR);
    const recent = computeTopicFrequency([{ year: 2025 }], CURRENT_YEAR);
    expect(recent.score).toBeGreaterThan(old.score);
  });

  it('excludes undated questions from year coverage but still counts them toward volume', () => {
    const result = computeTopicFrequency([{ year: null }, { year: null }], CURRENT_YEAR);
    expect(result.yearsSeen).toEqual([]);
    expect(result.questionCount).toBe(2);
    expect(result.score).toBeGreaterThan(0); // frequency component still contributes
  });

  it('respects configurable weights and thresholds', () => {
    const questions = [{ year: 2025 }];
    const defaultResult = computeTopicFrequency(questions, CURRENT_YEAR);
    const coverageOnlyResult = computeTopicFrequency(questions, CURRENT_YEAR, {
      weights: { frequency: 0, recency: 0, coverage: 1 },
    });
    expect(coverageOnlyResult.score).not.toBe(defaultResult.score);

    const alwaysHigh = computeTopicFrequency(questions, CURRENT_YEAR, { highThreshold: 0.01 });
    expect(alwaysHigh.level).toBe('HIGH');
  });

  it('does not present the score as a probability — only a bounded 0-1 relative signal', () => {
    const result = computeTopicFrequency([{ year: 2025 }, { year: 2024 }], CURRENT_YEAR);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
    expect(['NONE', 'LOW', 'MEDIUM', 'HIGH']).toContain(result.level);
  });
});

describe('PYQ intelligence API (integration)', () => {
  jest.setTimeout(60000);

  const owner = { name: 'PYQ Owner', email: 'pyqowner@test.com', password: 'password123' };
  const intruder = { name: 'PYQ Intruder', email: 'pyqintruder@test.com', password: 'password123' };

  let ownerToken, intruderToken;
  let examId, deadlocksTopicId;
  let pyqDocId;

  const pyqFile = path.join(__dirname, 'pyq-doc.txt');

  const PYQ_CONTENT = `Previous Year Questions - Operating Systems

2023
Q1. What is a deadlock? Explain the four necessary conditions for deadlock to occur.
Q2. Describe the Banker's Algorithm for deadlock avoidance.

2022
Q3. What is a deadlock and how can it be prevented using resource ordering?
`;

  beforeAll(async () => {
    fs.writeFileSync(pyqFile, PYQ_CONTENT);
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });

    let res = await request(app).post('/api/auth/register').send(owner);
    ownerToken = res.body.data.token;

    res = await request(app).post('/api/auth/register').send(intruder);
    intruderToken = res.body.data.token;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({
        name: 'PYQ Test Exam',
        subjects: [{ name: 'Operating Systems', topics: [{ name: 'Deadlocks' }, { name: 'Memory Management' }] }],
      });
    examId = res.body.data.id;
    deadlocksTopicId = res.body.data.subjects[0].topics.find((t) => t.name === 'Deadlocks').id;
  });

  afterAll(async () => {
    if (fs.existsSync(pyqFile)) fs.unlinkSync(pyqFile);
    await prisma.pyqQuestion.deleteMany({ where: { document: { user: { email: owner.email } } } });
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

  it('extracts questions, tracks years, and maps them to the correct topic during ingestion', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'OS PYQ 2022-2023')
      .field('examId', examId)
      .field('category', 'PYQ')
      .attach('file', pyqFile);
    pyqDocId = uploadRes.body.data.id;
    await waitForReady(pyqDocId);

    const res = await request(app)
      .get(`/api/documents/${pyqDocId}/questions`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);

    const deadlockQuestions = res.body.data.filter((q) => q.topicId === deadlocksTopicId);
    expect(deadlockQuestions.length).toBeGreaterThan(0);

    // At least one question should have a year tracked from "2023"/"2022" in the source.
    const withYear = res.body.data.filter((q) => q.year != null);
    expect(withYear.length).toBeGreaterThan(0);
    expect(withYear.every((q) => q.year === 2022 || q.year === 2023)).toBe(true);
  });

  it("shows the topic's PYQ analysis with historical importance scoring", async () => {
    const res = await request(app)
      .get(`/api/exams/${examId}/topics/${deadlocksTopicId}/pyq-analysis`)
      .set('Authorization', `Bearer ${ownerToken}`);

    expect(res.statusCode).toBe(200);
    expect(res.body.data.topic.name).toBe('Deadlocks');
    expect(res.body.data.questions.length).toBeGreaterThan(0);
    expect(['NONE', 'LOW', 'MEDIUM', 'HIGH']).toContain(res.body.data.frequency.level);
    expect(Array.isArray(res.body.data.frequency.yearsSeen)).toBe(true);
  });

  it("does not let another user see this exam's PYQ analysis or this document's questions", async () => {
    let res = await request(app)
      .get(`/api/exams/${examId}/topics/${deadlocksTopicId}/pyq-analysis`)
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);

    res = await request(app)
      .get(`/api/documents/${pyqDocId}/questions`)
      .set('Authorization', `Bearer ${intruderToken}`);
    expect(res.statusCode).toBe(404);
  });

  it('lets the owner confirm or reject a question mapping (the review mechanism)', async () => {
    const listRes = await request(app)
      .get(`/api/documents/${pyqDocId}/questions`)
      .set('Authorization', `Bearer ${ownerToken}`);
    const questionId = listRes.body.data[0].id;

    const rejectRes = await request(app)
      .patch(`/api/pyq-questions/${questionId}`)
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ status: 'REJECTED' });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.body.data.status).toBe('REJECTED');

    const intruderRes = await request(app)
      .patch(`/api/pyq-questions/${questionId}`)
      .set('Authorization', `Bearer ${intruderToken}`)
      .send({ status: 'CONFIRMED' });
    expect(intruderRes.statusCode).toBe(404);
  });

  it('rejects analyzing a document with no exam linked', async () => {
    const otherFile = path.join(__dirname, 'pyq-unlinked.txt');
    fs.writeFileSync(otherFile, 'Q1. Some question with no exam linked to map it against.');
    try {
      const uploadRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${ownerToken}`)
        .field('title', 'Unlinked PYQ')
        .field('category', 'PYQ')
        .attach('file', otherFile);
      const docId = uploadRes.body.data.id;
      await waitForReady(docId);

      const res = await request(app)
        .post(`/api/documents/${docId}/analyze-pyq`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.statusCode).toBe(400);
    } finally {
      if (fs.existsSync(otherFile)) fs.unlinkSync(otherFile);
    }
  });

  it('rejects analyzing a non-PYQ document even when linked to an exam', async () => {
    const otherFile = path.join(__dirname, 'pyq-notes.txt');
    fs.writeFileSync(otherFile, 'Just some general notes, not a question paper.');
    try {
      const uploadRes = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${ownerToken}`)
        .field('title', 'General Notes')
        .field('examId', examId)
        .field('category', 'NOTES')
        .attach('file', otherFile);
      const docId = uploadRes.body.data.id;
      await waitForReady(docId);

      const res = await request(app)
        .post(`/api/documents/${docId}/analyze-pyq`)
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.statusCode).toBe(400);
    } finally {
      if (fs.existsSync(otherFile)) fs.unlinkSync(otherFile);
    }
  });
});
