const request = require('supertest');
const app = require('../src/app');

describe('Health Check API', () => {
  describe('GET /api/health', () => {
    it('should return 200 and a success message', async () => {
      const res = await request(app).get('/api/health');
      
      expect(res.statusCode).toEqual(200);
      expect(res.body).toHaveProperty('success', true);
      expect(res.body).toHaveProperty('message', 'AI Study Companion API is running');
    });
  });

  describe('Invalid Route', () => {
    it('should return 404 for an unknown route', async () => {
      const res = await request(app).get('/api/unknown-route');
      
      expect(res.statusCode).toEqual(404);
      expect(res.body).toHaveProperty('success', false);
      expect(res.body.message).toMatch(/Not Found/);
    });
  });
});
