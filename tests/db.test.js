const prisma = require('../src/config/db');

describe('Database Connection', () => {
  beforeAll(async () => {
    // Explicitly connect to ensure any connection errors are caught early
    await prisma.$connect();
  });

  afterAll(async () => {
    // Disconnect after tests
    await prisma.$disconnect();
  });

  it('should connect to the database successfully by running a simple query', async () => {
    // Run a raw query to check the connection
    const result = await prisma.$queryRaw`SELECT 1 as result`;
    expect(result).toBeDefined();
    expect(result[0].result).toBe(1);
  });
});
