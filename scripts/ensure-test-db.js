require('dotenv').config({ quiet: true });
const { PrismaClient } = require('@prisma/client');
const { execSync } = require('child_process');

async function main() {
  const source = process.env.DATABASE_URL;
  if (!source) throw new Error('DATABASE_URL missing');
  const adminUrl = source.replace(/\/[^/?]+(\?|$)/, '/postgres$1');
  const testUrl = source.replace(/\/[^/?]+(\?|$)/, '/social_calling_test$1');

  process.env.DATABASE_URL = adminUrl;
  const admin = new PrismaClient();
  try {
    await admin.$executeRawUnsafe('CREATE DATABASE social_calling_test');
    console.log('created social_calling_test');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/already exists/i.test(message)) console.log('social_calling_test already exists');
    else throw err;
  } finally {
    await admin.$disconnect();
  }

  process.env.DATABASE_URL = testUrl;
  execSync('npx prisma migrate deploy', { stdio: 'inherit', env: process.env });
  console.log('migrations applied');
}

main().catch((err) => { console.error(err); process.exit(1); });
