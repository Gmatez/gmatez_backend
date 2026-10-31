
import { PrismaClient, UserRole } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;

  if (!email || !password || password.length < 12) {
    throw new Error(
      'Set ADMIN_EMAIL and ADMIN_PASSWORD (minimum 12 characters).',
    );
  }

  const passwordHash = await argon2.hash(password, {
    type: argon2.argon2id,
  });

  const admin = await prisma.user.upsert({
    where: { email },
    update: {},
    create: {
      email,
      passwordHash,
      role: UserRole.ADMIN,
      profile: {
        create: {
          displayName: 'Gmatez Admin',
          bio: 'Platform administrator',
          isDiscoverable: false,
        },
      },
      wallet: {
        create: {},
      },
    },
    select: {
      id: true,
      email: true,
      role: true,
    },
  });

  console.log('Admin account ready:', admin);
}

main()
  .catch((error) => {
    console.error('Admin creation failed:', error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
