const { PrismaClient } = require('@prisma/client');
const { Pool } = require('pg');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config();

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

async function dropColumn() {
  try {
    await prisma.$executeRawUnsafe('ALTER TABLE "DocumentChunk" DROP COLUMN IF EXISTS "embedding";');
    console.log('Column dropped successfully.');
  } catch (err) {
    console.error('Error dropping column:', err);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

dropColumn();
