const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const DocumentProcessingService = require('../src/ai/services/documentProcessing.service');
const path = require('path');
const fs = require('fs');

describe('Document Management API', () => {
  const testUser = {
    name: 'Doc Test User',
    email: 'doctest@example.com',
    password: 'password123',
  };
  const intruder = {
    name: 'Doc Test Intruder',
    email: 'doctestintruder@example.com',
    password: 'password123',
  };
  let token = '';
  let intruderToken = '';
  let documentId = '';
  let examId = '';

  const testFilePath = path.join(__dirname, 'test.txt');
  const otherFilePath = path.join(__dirname, 'test-other.txt');
  const unsupportedFilePath = path.join(__dirname, 'test.exe');
  const largeFilePath = path.join(__dirname, 'test-large.txt');

  beforeAll(async () => {
    fs.writeFileSync(testFilePath, 'This is a test document.');
    fs.writeFileSync(otherFilePath, 'This is a different test document about deadlocks and scheduling.');
    fs.writeFileSync(unsupportedFilePath, 'fake binary content');
    fs.writeFileSync(largeFilePath, Buffer.alloc(11 * 1024 * 1024, 'a')); // 11MB, over the 10MB limit

    await prisma.$connect();
    await prisma.document.deleteMany({ where: { user: { email: { in: [testUser.email, intruder.email] } } } });
    await prisma.exam.deleteMany({ where: { user: { email: { in: [testUser.email, intruder.email] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [testUser.email, intruder.email] } } });

    let res = await request(app).post('/api/auth/register').send(testUser);
    token = res.body.data.token;

    res = await request(app).post('/api/auth/register').send(intruder);
    intruderToken = res.body.data.token;

    res = await request(app)
      .post('/api/exams')
      .set('Authorization', `Bearer ${token}`)
      .send({ name: 'Doc Test Exam' });
    examId = res.body.data.id;
  });

  afterAll(async () => {
    // Uploads/retries kick off real, unawaited background processing —
    // draining tracked jobs (see documentProcessing.service.js) before
    // cleanup avoids racing a delete/disconnect against one still in flight.
    // jest.setup.js does this globally too, but doing it here first means
    // this file's own DB cleanup below doesn't race it either.
    await DocumentProcessingService.waitForAllBackgroundProcessing();

    for (const p of [testFilePath, otherFilePath, unsupportedFilePath, largeFilePath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    await prisma.document.deleteMany({ where: { user: { email: { in: [testUser.email, intruder.email] } } } });
    await prisma.exam.deleteMany({ where: { user: { email: { in: [testUser.email, intruder.email] } } } });
    await prisma.user.deleteMany({ where: { email: { in: [testUser.email, intruder.email] } } });
    await prisma.$disconnect();
  });

  describe('POST /api/documents', () => {
    it('should upload a valid text document', async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .field('title', 'My Test Doc')
        .attach('file', testFilePath);

      expect(res.statusCode).toEqual(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('id');
      expect(res.body.data.title).toBe('My Test Doc');
      // Background processing starts immediately (non-blocking upload), so
      // by the time the response lands the status may already have moved
      // past UPLOADED — assert it's a valid in-flight/terminal state instead
      // of the exact instant it was in.
      expect(['UPLOADED', 'PROCESSING', 'READY']).toContain(res.body.data.processingStatus);
      expect(res.body.data.category).toBe('GENERAL');

      documentId = res.body.data.id;
    });

    it('should fail without a file', async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .field('title', 'Missing File');

      expect(res.statusCode).toEqual(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Please upload a file/i);
    });

    it('should fail without a title', async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .attach('file', otherFilePath);

      expect(res.statusCode).toEqual(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Please provide a title/i);
    });

    it('should reject an unsupported file type', async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .field('title', 'Bad File Type')
        .attach('file', unsupportedFilePath);

      expect(res.statusCode).toEqual(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/invalid file type/i);
    });

    it('should reject a file over the size limit', async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .field('title', 'Too Big')
        .attach('file', largeFilePath);

      expect(res.statusCode).toEqual(400);
      expect(res.body.success).toBe(false);
    }, 30000);

    it('should reject re-uploading the exact same file content', async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .field('title', 'My Test Doc Again')
        .attach('file', testFilePath); // same content as the first upload

      expect(res.statusCode).toEqual(409);
      expect(res.body.message).toMatch(/already uploaded/i);
    });

    it('should reject an invalid category', async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .field('title', 'Bad Category')
        .field('category', 'NOT_A_REAL_CATEGORY')
        .attach('file', otherFilePath);

      expect(res.statusCode).toEqual(400);
      expect(res.body.message).toMatch(/invalid category/i);
    });

    it('should link a document to an exam the user owns', async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${token}`)
        .field('title', 'Exam Linked Doc')
        .field('examId', examId)
        .field('category', 'NOTES')
        .attach('file', otherFilePath);

      expect(res.statusCode).toEqual(201);
      expect(res.body.data.examId).toBe(examId);
      expect(res.body.data.category).toBe('NOTES');
    });

    it("should reject linking to another user's exam", async () => {
      const res = await request(app)
        .post('/api/documents')
        .set('Authorization', `Bearer ${intruderToken}`)
        .field('title', 'Hijack Attempt')
        .field('examId', examId)
        .attach('file', testFilePath); // exam ownership is checked before the file is even touched

      expect(res.statusCode).toEqual(404);
    });
  });

  describe('GET /api/documents', () => {
    it('should get all documents for the user', async () => {
      const res = await request(app)
        .get('/api/documents')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(Array.isArray(res.body.data)).toBe(true);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
    });

    it('should filter documents by examId', async () => {
      const res = await request(app)
        .get(`/api/documents?examId=${examId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.length).toBeGreaterThanOrEqual(1);
      expect(res.body.data.every((d) => d.examId === examId)).toBe(true);
    });
  });

  describe('GET /api/documents/:id', () => {
    it('should get a specific document', async () => {
      const res = await request(app)
        .get(`/api/documents/${documentId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe(documentId);
    });

    it('should fail for non-existent document', async () => {
      const res = await request(app)
        .get('/api/documents/non-existent-id')
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(404);
    });
  });

  describe('PATCH /api/documents/:id', () => {
    it('updates the category', async () => {
      const res = await request(app)
        .patch(`/api/documents/${documentId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ category: 'PYQ' });

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.category).toBe('PYQ');
    });

    it('rejects an invalid category', async () => {
      const res = await request(app)
        .patch(`/api/documents/${documentId}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ category: 'NOT_REAL' });

      expect(res.statusCode).toEqual(400);
    });

    it("rejects updating another user's document", async () => {
      const res = await request(app)
        .patch(`/api/documents/${documentId}`)
        .set('Authorization', `Bearer ${intruderToken}`)
        .send({ category: 'NOTES' });

      expect(res.statusCode).toEqual(404);
    });
  });

  describe('GET /api/documents/:id/status', () => {
    it('should get processing status', async () => {
      const res = await request(app)
        .get(`/api/documents/${documentId}/status`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(['UPLOADED', 'PROCESSING', 'READY']).toContain(res.body.data.status);
    });
  });

  describe('POST /api/documents/:id/retry', () => {
    it('should reject retrying a document that has not failed', async () => {
      const res = await request(app)
        .post(`/api/documents/${documentId}/retry`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(400);
      expect(res.body.message).toMatch(/only failed documents/i);
    });

    it('should reset a failed document to UPLOADED and reprocess it', async () => {
      // Force the document into a FAILED state to exercise the retry path,
      // rather than trying to make the real AI pipeline fail deterministically.
      await prisma.document.update({ where: { id: documentId }, data: { processingStatus: 'FAILED' } });

      const res = await request(app)
        .post(`/api/documents/${documentId}/retry`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.data.processingStatus).toBe('UPLOADED');

      // Wait for the real reprocessing this kicks off in the background to
      // actually finish before a later test deletes this same document —
      // otherwise the delete races the in-flight LLM calls.
      await DocumentProcessingService.waitForAllBackgroundProcessing();
    }, 45000);

    it("should reject retrying another user's document", async () => {
      await prisma.document.update({ where: { id: documentId }, data: { processingStatus: 'FAILED' } });

      const res = await request(app)
        .post(`/api/documents/${documentId}/retry`)
        .set('Authorization', `Bearer ${intruderToken}`);

      expect(res.statusCode).toEqual(404);
    });
  });

  describe('DELETE /api/documents/:id', () => {
    it('should delete the document', async () => {
      const res = await request(app)
        .delete(`/api/documents/${documentId}`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);

      // Verify it's gone
      const checkRes = await request(app)
        .get(`/api/documents/${documentId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(checkRes.statusCode).toEqual(404);
    });
  });
});
