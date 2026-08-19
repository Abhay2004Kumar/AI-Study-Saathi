const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const path = require('path');
const fs = require('fs');

describe('Document Management API', () => {
  const testUser = {
    name: 'Doc Test User',
    email: 'doctest@example.com',
    password: 'password123',
  };
  let token = '';
  let documentId = '';

  const testFilePath = path.join(__dirname, 'test.txt');

  beforeAll(async () => {
    // Create test file
    fs.writeFileSync(testFilePath, 'This is a test document.');

    await prisma.$connect();
    await prisma.document.deleteMany({ where: { user: { email: testUser.email } } });
    await prisma.user.deleteMany({ where: { email: testUser.email } });

    // Register test user
    const res = await request(app).post('/api/auth/register').send(testUser);
    token = res.body.data.token;
  });

  afterAll(async () => {
    // Clean up
    if (fs.existsSync(testFilePath)) {
      fs.unlinkSync(testFilePath);
    }
    await prisma.document.deleteMany({ where: { user: { email: testUser.email } } });
    await prisma.user.deleteMany({ where: { email: testUser.email } });
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
      expect(res.body.data.processingStatus).toBe('UPLOADED');

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
        .attach('file', testFilePath);

      expect(res.statusCode).toEqual(400);
      expect(res.body.success).toBe(false);
      expect(res.body.message).toMatch(/Please provide a title/i);
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

  describe('GET /api/documents/:id/status', () => {
    it('should get processing status', async () => {
      const res = await request(app)
        .get(`/api/documents/${documentId}/status`)
        .set('Authorization', `Bearer ${token}`);

      expect(res.statusCode).toEqual(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.status).toBe('UPLOADED');
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
