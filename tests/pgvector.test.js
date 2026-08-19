const EmbeddingService = require('../src/ai/services/embedding.service');
const prisma = require('../src/config/db');

describe('PGVector and Similarity Search', () => {
  // We use live API for embedding generation, so increase timeout
  jest.setTimeout(15000);

  let docId = 'test-doc-id';

  beforeAll(async () => {
    await prisma.$connect();
    // Clean up if previous tests failed
    await prisma.$executeRaw`DELETE FROM "DocumentChunk" WHERE "documentId" = ${docId}`;
    await prisma.$executeRaw`DELETE FROM "Document" WHERE "id" = ${docId}`;
    await prisma.$executeRaw`DELETE FROM "User" WHERE "email" = 'pgvector@test.com'`;

    // 1. Create a dummy user and document
    const user = await prisma.user.create({
      data: { name: 'Vector User', email: 'pgvector@test.com', passwordHash: 'hash' }
    });
    
    await prisma.$executeRaw`
      INSERT INTO "Document" ("id", "userId", "title", "fileName", "filePath", "fileType", "fileSize", "updatedAt")
      VALUES (${docId}, ${user.id}, 'Physics Notes', 'physics.txt', '/tmp/physics.txt', 'text/plain', 100, NOW())
    `;

    // 2. Add some chunks with embeddings directly
    const texts = [
      'Newton\'s first law of motion states that an object at rest stays at rest.',
      'Mitochondria is the powerhouse of the cell.', // Biology, not physics, but good for test
      'Gravity is a force of attraction that exists between any two masses.',
    ];
    
    const embeddings = await EmbeddingService.generateEmbeddings(texts);

    for (let i = 0; i < texts.length; i++) {
      const vectorStr = `[${embeddings[i].join(',')}]`;
      await prisma.$executeRaw`
        INSERT INTO "DocumentChunk" ("id", "documentId", "content", "chunkIndex", "embedding")
        VALUES (gen_random_uuid(), ${docId}, ${texts[i]}, ${i}, ${vectorStr}::vector)
      `;
    }
  });

  afterAll(async () => {
    // Clean up
    await prisma.$executeRaw`DELETE FROM "DocumentChunk" WHERE "documentId" = ${docId}`;
    await prisma.$executeRaw`DELETE FROM "Document" WHERE "id" = ${docId}`;
    await prisma.$executeRaw`DELETE FROM "User" WHERE "email" = 'pgvector@test.com'`;
    await prisma.$disconnect();
  });

  it('should find the most similar chunk using cosine distance (<=>)', async () => {
    // We search for something related to gravity
    const query = 'What pulls objects toward each other?';
    
    const queryEmbedding = await EmbeddingService.generateEmbedding(query);
    const vectorStr = `[${queryEmbedding.join(',')}]`;

    // Use pgvector's cosine distance `<=>` operator to find the closest match.
    // We order by distance ascending (closest first) and limit to 1.
    const results = await prisma.$queryRaw`
      SELECT id, content, "chunkIndex", ("embedding" <=> ${vectorStr}::vector) as distance
      FROM "DocumentChunk"
      WHERE "documentId" = ${docId}
      ORDER BY "embedding" <=> ${vectorStr}::vector
      LIMIT 1
    `;

    expect(results).toBeInstanceOf(Array);
    expect(results.length).toBe(1);
    
    // The closest match should definitely be the gravity string
    expect(results[0].content).toContain('Gravity');
    
    console.log(`Query: "${query}"`);
    console.log(`Closest match found: "${results[0].content}"`);
    console.log(`Cosine Distance: ${results[0].distance}`);
  });
});
