require('dotenv').config();
const { PrismaClient } = require('@prisma/client');

const source = process.env.DATABASE_URL;
if (!source) {
  console.error('DATABASE_URL missing');
  process.exit(1);
}
const testUrl = source.replace(/\/[^/?]+(\?|$)/, '/social_calling_test$1');
process.env.DATABASE_URL = testUrl;
console.log('Trying', testUrl.replace(/:[^:@]+@/, ':***@'));

const prisma = new PrismaClient();
prisma
  .$connect()
  .then(() => prisma.$queryRawUnsafe('SELECT 1 AS ok'))
  .then((rows) => {
    console.log('OK', rows);
    return prisma.$disconnect();
  })
  .catch(async (err) => {
    console.error('FAIL', err.message);
    await prisma.$disconnect().catch(() => undefined);
    process.exit(1);
  });
