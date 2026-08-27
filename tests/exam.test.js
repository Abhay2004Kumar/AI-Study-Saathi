const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');

describe('Exam & Syllabus API', () => {
  const owner = { name: 'Exam Owner', email: 'examowner@example.com', password: 'password123' };
  const intruder = { name: 'Exam Intruder', email: 'examintruder@example.com', password: 'password123' };
  let ownerToken;
  let intruderToken;
  let examId;

  beforeAll(async () => {
    await prisma.$connect();
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });

    let res = await request(app).post('/api/auth/register').send(owner);
    ownerToken = res.body.data.token;

    res = await request(app).post('/api/auth/register').send(intruder);
    intruderToken = res.body.data.token;
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { in: [owner.email, intruder.email] } } });
    await prisma.$disconnect();
  });

  describe('POST /api/exams', () => {
    it('creates an exam with a nested syllabus tree', async () => {
      const res = await request(app)
        .post('/api/exams')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'STET Computer Science',
          examDate: '2026-12-01',
          availableHoursPerDay: 3,
          subjects: [
            {
              name: 'Data Structures',
              topics: [
                { name: 'Trees', subtopics: [{ name: 'Binary Search Trees' }, { name: 'AVL Trees' }] },
                { name: 'Graphs' },
              ],
            },
            { name: 'DBMS', topics: [{ name: 'Normalization' }] },
          ],
        });

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.subjects).toHaveLength(2);

      const ds = res.body.data.subjects.find((s) => s.name === 'Data Structures');
      expect(ds.topics).toHaveLength(2);
      const trees = ds.topics.find((t) => t.name === 'Trees');
      expect(trees.subtopics.map((st) => st.name).sort()).toEqual(['AVL Trees', 'Binary Search Trees']);

      examId = res.body.data.id;
    });

    it('rejects an exam without a name', async () => {
      const res = await request(app)
        .post('/api/exams')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ description: 'no name' });

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('rejects duplicate topic names within the same subject', async () => {
      const res = await request(app)
        .post('/api/exams')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          name: 'Duplicate Test Exam',
          subjects: [{ name: 'OS', topics: [{ name: 'Deadlocks' }, { name: 'Deadlocks' }] }],
        });

      expect(res.statusCode).toBe(400);
      expect(res.body.message).toMatch(/duplicate/i);
    });

    it('rejects an invalid examDate', async () => {
      const res = await request(app)
        .post('/api/exams')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Bad Date Exam', examDate: 'not-a-date' });

      expect(res.statusCode).toBe(400);
    });

    // Regression: a large tree (e.g. from AI extraction) does one DB round
    // trip per node inside the replaceSyllabus transaction against a remote
    // pooled Postgres instance — this used to exceed Prisma's 5s default
    // interactive-transaction timeout. See exam.service.js replaceSyllabus.
    it('creates a large syllabus tree without hitting the transaction timeout', async () => {
      const subjects = Array.from({ length: 6 }, (_, si) => ({
        name: `Large Subject ${si}`,
        topics: Array.from({ length: 5 }, (_, ti) => ({
          name: `Large Subject ${si} Topic ${ti}`,
          subtopics: Array.from({ length: 3 }, (_, sti) => ({
            name: `Large Subject ${si} Topic ${ti} Subtopic ${sti}`,
          })),
        })),
      }));

      const res = await request(app)
        .post('/api/exams')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ name: 'Large Syllabus Exam', subjects });

      expect(res.statusCode).toBe(201);
      expect(res.body.data.subjects).toHaveLength(6);
      expect(res.body.data.subjects[0].topics).toHaveLength(5);
      expect(res.body.data.subjects[0].topics[0].subtopics).toHaveLength(3);

      await prisma.exam.delete({ where: { id: res.body.data.id } });
    }, 30000);
  });

  describe('GET /api/exams', () => {
    it("lists only the caller's exams", async () => {
      const res = await request(app).get('/api/exams').set('Authorization', `Bearer ${ownerToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.some((e) => e.id === examId)).toBe(true);

      const intruderRes = await request(app).get('/api/exams').set('Authorization', `Bearer ${intruderToken}`);
      expect(intruderRes.body.data.some((e) => e.id === examId)).toBe(false);
    });

    it('rejects an unauthenticated request', async () => {
      const res = await request(app).get('/api/exams');
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/exams/:id', () => {
    it('returns the full nested tree for the owner', async () => {
      const res = await request(app).get(`/api/exams/${examId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.statusCode).toBe(200);
      expect(res.body.data.subjects.length).toBeGreaterThan(0);
    });

    it('returns 404 for another user instead of leaking existence', async () => {
      const res = await request(app).get(`/api/exams/${examId}`).set('Authorization', `Bearer ${intruderToken}`);
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for a non-existent exam', async () => {
      const res = await request(app)
        .get('/api/exams/00000000-0000-0000-0000-000000000000')
        .set('Authorization', `Bearer ${ownerToken}`);
      expect(res.statusCode).toBe(404);
    });
  });

  describe('PATCH /api/exams/:id', () => {
    it('updates exam metadata without touching the syllabus', async () => {
      const res = await request(app)
        .patch(`/api/exams/${examId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ availableHoursPerDay: 5 });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.availableHoursPerDay).toBe(5);
      expect(res.body.data.subjects.length).toBeGreaterThan(0);
    });

    it('blocks another user from updating', async () => {
      const res = await request(app)
        .patch(`/api/exams/${examId}`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .send({ name: 'Hijacked' });

      expect(res.statusCode).toBe(404);
    });

    it('rejects an empty update body', async () => {
      const res = await request(app)
        .patch(`/api/exams/${examId}`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/exams/:id/syllabus', () => {
    it('preserves stable ids for kept nodes and removes dropped ones', async () => {
      const before = await request(app).get(`/api/exams/${examId}`).set('Authorization', `Bearer ${ownerToken}`);
      const dsSubject = before.body.data.subjects.find((s) => s.name === 'Data Structures');
      const treesTopic = dsSubject.topics.find((t) => t.name === 'Trees');

      const res = await request(app)
        .put(`/api/exams/${examId}/syllabus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          subjects: [
            {
              id: dsSubject.id,
              name: 'Data Structures',
              topics: [
                // keeps Trees (drops AVL Trees subtopic), drops Graphs, adds Linked Lists
                { id: treesTopic.id, name: 'Trees', subtopics: [{ name: 'Binary Search Trees' }] },
                { name: 'Linked Lists' },
              ],
            },
            // DBMS subject omitted entirely -> should be deleted
          ],
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.data.subjects).toHaveLength(1);

      const updatedDs = res.body.data.subjects[0];
      expect(updatedDs.id).toBe(dsSubject.id);
      expect(updatedDs.topics.map((t) => t.name).sort()).toEqual(['Linked Lists', 'Trees']);

      const updatedTrees = updatedDs.topics.find((t) => t.name === 'Trees');
      expect(updatedTrees.id).toBe(treesTopic.id);
      expect(updatedTrees.subtopics.map((st) => st.name)).toEqual(['Binary Search Trees']);

      const remainingSubjects = await prisma.subject.count({ where: { examId } });
      expect(remainingSubjects).toBe(1);
    });

    it('rejects a payload with an invalid shape', async () => {
      const res = await request(app)
        .put(`/api/exams/${examId}/syllabus`)
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({ subjects: [{ topics: [] }] }); // missing required subject name

      expect(res.statusCode).toBe(400);
    });

    it('blocks another user from replacing the syllabus', async () => {
      const res = await request(app)
        .put(`/api/exams/${examId}/syllabus`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .send({ subjects: [{ name: 'Hijacked Subject' }] });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/exams/syllabus/extract', () => {
    it('extracts a structured syllabus from raw text', async () => {
      const res = await request(app)
        .post('/api/exams/syllabus/extract')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({
          text: `Operating Systems Syllabus

Unit 1: Process Management - process states, scheduling algorithms
Unit 2: Deadlocks - detection, prevention, avoidance
Unit 3: Memory Management - paging, segmentation`,
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data.subjects)).toBe(true);
      expect(res.body.data.subjects.length).toBeGreaterThan(0);
    }, 30000);

    it('rejects an extraction request with no text or file', async () => {
      const res = await request(app)
        .post('/api/exams/syllabus/extract')
        .set('Authorization', `Bearer ${ownerToken}`)
        .send({});

      expect(res.statusCode).toBe(400);
    });
  });

  describe('DELETE /api/exams/:id', () => {
    it('blocks another user from deleting', async () => {
      const res = await request(app).delete(`/api/exams/${examId}`).set('Authorization', `Bearer ${intruderToken}`);
      expect(res.statusCode).toBe(404);
    });

    it('deletes the exam and cascades its syllabus', async () => {
      const res = await request(app).delete(`/api/exams/${examId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(res.statusCode).toBe(200);

      const check = await request(app).get(`/api/exams/${examId}`).set('Authorization', `Bearer ${ownerToken}`);
      expect(check.statusCode).toBe(404);

      const remainingSubjects = await prisma.subject.count({ where: { examId } });
      expect(remainingSubjects).toBe(0);
    });
  });
});
