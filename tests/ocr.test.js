const request = require('supertest');
const app = require('../src/app');
const prisma = require('../src/config/db');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

describe('Image OCR ingestion (integration)', () => {
  jest.setTimeout(60000);

  const owner = { name: 'OCR Owner', email: 'ocrowner@test.com', password: 'password123' };
  let ownerToken;

  const notesImagePath = path.join(__dirname, 'ocr-notes.png');
  const blankImagePath = path.join(__dirname, 'ocr-blank.png');

  // A distinctive keyword unlikely to appear by chance, so a fuzzy
  // "did OCR actually read this" check doesn't need an exact-string match
  // against the model's own transcription.
  const KEYWORD = 'Chlorophyll';
  const NOTES_SVG = `
    <svg width="900" height="300" xmlns="http://www.w3.org/2000/svg">
      <rect width="900" height="300" fill="white"/>
      <text x="30" y="60" font-family="Arial" font-size="34" fill="black">Photosynthesis Notes</text>
      <text x="30" y="130" font-family="Arial" font-size="28" fill="black">Plants use ${KEYWORD} to capture sunlight.</text>
      <text x="30" y="180" font-family="Arial" font-size="28" fill="black">Light energy is converted into chemical energy.</text>
      <text x="30" y="230" font-family="Arial" font-size="28" fill="black">The reaction occurs inside the chloroplast.</text>
    </svg>
  `;
  const BLANK_SVG = `<svg width="400" height="200" xmlns="http://www.w3.org/2000/svg"><rect width="400" height="200" fill="white"/></svg>`;

  beforeAll(async () => {
    await sharp(Buffer.from(NOTES_SVG)).png().toFile(notesImagePath);
    await sharp(Buffer.from(BLANK_SVG)).png().toFile(blankImagePath);

    await prisma.user.deleteMany({ where: { email: owner.email } });
    const res = await request(app).post('/api/auth/register').send(owner);
    ownerToken = res.body.data.token;
  });

  afterAll(async () => {
    if (fs.existsSync(notesImagePath)) fs.unlinkSync(notesImagePath);
    if (fs.existsSync(blankImagePath)) fs.unlinkSync(blankImagePath);
    await prisma.documentChunk.deleteMany({ where: { document: { user: { email: owner.email } } } });
    await prisma.document.deleteMany({ where: { user: { email: owner.email } } });
    await prisma.user.deleteMany({ where: { email: owner.email } });
    await prisma.$disconnect();
  });

  const waitForSettled = async (documentId, timeoutMs = 45000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const doc = await prisma.document.findUnique({ where: { id: documentId } });
      if (doc.processingStatus === 'READY' || doc.processingStatus === 'FAILED') return doc;
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`Document ${documentId} did not finish processing in time`);
  };

  it('transcribes legible text out of an uploaded photo of notes and makes it searchable', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'Photographed Notes')
      .field('category', 'NOTES')
      .attach('file', notesImagePath);
    expect(uploadRes.statusCode).toBe(201);
    const documentId = uploadRes.body.data.id;

    const doc = await waitForSettled(documentId);
    expect(doc.processingStatus).toBe('READY');

    const chunks = await prisma.documentChunk.findMany({ where: { documentId } });
    expect(chunks.length).toBeGreaterThan(0);

    const allChunkText = chunks.map((c) => c.content).join(' ');
    expect(allChunkText.toLowerCase()).toContain(KEYWORD.toLowerCase());

    // Marked as OCR-derived for downstream transparency (e.g. source citations).
    expect(chunks.some((c) => c.metadata?.ocr === true)).toBe(true);

    // Classification (Phase 3) ran on the OCR'd text same as any other document.
    expect(doc.aiCategory).not.toBeNull();
  });

  it('handles an image with no legible text gracefully — READY, zero chunks, no crash', async () => {
    const uploadRes = await request(app)
      .post('/api/documents')
      .set('Authorization', `Bearer ${ownerToken}`)
      .field('title', 'Blank Image')
      .field('category', 'GENERAL')
      .attach('file', blankImagePath);
    expect(uploadRes.statusCode).toBe(201);
    const documentId = uploadRes.body.data.id;

    const doc = await waitForSettled(documentId);
    expect(doc.processingStatus).toBe('READY');

    const chunks = await prisma.documentChunk.findMany({ where: { documentId } });
    expect(chunks.length).toBe(0);
  });
});
