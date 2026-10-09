import { PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

const password = 'ChangeMe123!';

async function upsertUser(input: {
  email: string;
  phone?: string;
  role?: 'USER' | 'ADMIN';
  displayName: string;
  bio: string;
  language?: string;
  country?: string;
  gender?: 'FEMALE' | 'MALE' | 'OTHER' | 'UNSPECIFIED';
  ratePerMinuteCents?: number;
  isDiscoverable?: boolean;
  walletCents?: number;
  lastActiveAt?: Date;
}) {
  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const user = await prisma.user.upsert({
    where: { email: input.email },
    update: {
      phone: input.phone,
      profile: {
        update: {
          displayName: input.displayName,
          bio: input.bio,
          language: input.language,
          country: input.country,
          gender: input.gender,
          ratePerMinuteCents: input.ratePerMinuteCents ?? 100,
          isDiscoverable: input.isDiscoverable ?? true,
          lastActiveAt: input.lastActiveAt ?? new Date(),
        },
      },
    },
    create: {
      email: input.email,
      phone: input.phone,
      passwordHash,
      role: input.role ?? 'USER',
      profile: {
        create: {
          displayName: input.displayName,
          bio: input.bio,
          language: input.language,
          country: input.country,
          gender: input.gender ?? 'UNSPECIFIED',
          ratePerMinuteCents: input.ratePerMinuteCents ?? 100,
          isDiscoverable: input.isDiscoverable ?? true,
          lastActiveAt: input.lastActiveAt ?? new Date(),
        },
      },
      wallet: { create: {} },
    },
  });
  if (input.walletCents && input.walletCents > 0) {
    const wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: user.id },
    });
    await prisma.walletLedgerEntry.upsert({
      where: { idempotencyKey: `seed:${input.email}:promo` },
      update: {},
      create: {
        walletId: wallet.id,
        type: 'CREDIT',
        reason: 'PROMOTIONAL_CREDIT',
        amountCents: input.walletCents,
        balanceAfterCents: input.walletCents,
        idempotencyKey: `seed:${input.email}:promo`,
      },
    });
    await prisma.wallet.update({
      where: { userId: user.id },
      data: { availableBalanceCents: input.walletCents },
    });
  }
  return user;
}

async function upsertHost(
  userId: string,
  input: {
    status: 'PENDING_REVIEW' | 'ACTIVE' | 'SUSPENDED' | 'REJECTED';
    availability?: 'OFFLINE' | 'ONLINE' | 'BUSY' | 'PAUSED';
    languages?: string[];
    interests?: string[];
    voiceRatePerMinuteCents?: number;
    videoRatePerMinuteCents?: number;
    applicationBio?: string;
  },
) {
  await prisma.hostProfile.upsert({
    where: { userId },
    update: {
      status: input.status,
      availability: input.availability ?? 'OFFLINE',
      languages: input.languages ?? ['en'],
      interests: input.interests ?? ['conversation'],
      voiceRatePerMinuteCents: input.voiceRatePerMinuteCents ?? 100,
      videoRatePerMinuteCents: input.videoRatePerMinuteCents ?? 150,
      applicationBio: input.applicationBio ?? 'Development host',
    },
    create: {
      userId,
      status: input.status,
      availability: input.availability ?? 'OFFLINE',
      languages: input.languages ?? ['en'],
      interests: input.interests ?? ['conversation'],
      voiceRatePerMinuteCents: input.voiceRatePerMinuteCents ?? 100,
      videoRatePerMinuteCents: input.videoRatePerMinuteCents ?? 150,
      applicationBio: input.applicationBio ?? 'Development host',
    },
  });
  for (const item of [
    ['HOST_GUIDELINES', '1.0'],
    ['TERMS_OF_SERVICE', '1.0'],
    ['PRIVACY_POLICY', '1.0'],
  ] as const) {
    await prisma.hostAgreementAcceptance.upsert({
      where: {
        userId_agreementType_version: {
          userId,
          agreementType: item[0],
          version: item[1],
        },
      },
      create: { userId, agreementType: item[0], version: item[1] },
      update: {},
    });
  }
}

async function main() {
  const now = Date.now();
  const admin = await upsertUser({
    email: 'admin@example.com',
    role: 'ADMIN',
    displayName: 'Admin',
    bio: 'Development admin account',
    isDiscoverable: false,
  });
  const alice = await upsertUser({
    email: 'alice@example.com',
    phone: '+919778741983',
    displayName: 'Alex Kumar',
    bio: 'Caller with credits for development',
    language: 'en',
    country: 'US',
    gender: 'FEMALE',
    walletCents: 5000,
    isDiscoverable: false,
    lastActiveAt: new Date(now - 60_000),
  });
  const bob = await upsertUser({
    email: 'bob@example.com',
    phone: '+919876543210',
    displayName: 'Bob',
    bio: 'English conversations, calm and curious',
    language: 'en',
    country: 'GB',
    gender: 'MALE',
    ratePerMinuteCents: 100,
    lastActiveAt: new Date(now - 120_000),
  });
  await upsertHost(bob.id, {
    status: 'ACTIVE',
    availability: 'ONLINE',
    languages: ['en'],
    interests: ['music', 'travel'],
    voiceRatePerMinuteCents: 100,
    videoRatePerMinuteCents: 160,
    applicationBio: 'I host thoughtful voice chats.',
  });
  const carol = await upsertUser({
    email: 'carol@example.com',
    displayName: 'Carol',
    bio: 'Night-owl conversations in Spanish',
    language: 'es',
    country: 'ES',
    gender: 'FEMALE',
    ratePerMinuteCents: 120,
    lastActiveAt: new Date(now - 180_000),
  });
  await upsertHost(carol.id, {
    status: 'ACTIVE',
    availability: 'OFFLINE',
    languages: ['es', 'en'],
    interests: ['nightlife', 'languages'],
    voiceRatePerMinuteCents: 120,
    videoRatePerMinuteCents: 180,
    applicationBio: 'Night-owl Spanish and English chats.',
  });
  const dave = await upsertUser({
    email: 'dave@example.com',
    displayName: 'Dave',
    bio: 'Looking for thoughtful audio chats',
    language: 'en',
    country: 'CA',
    gender: 'MALE',
    ratePerMinuteCents: 80,
    lastActiveAt: new Date(now - 240_000),
  });
  await upsertHost(dave.id, {
    status: 'ACTIVE',
    availability: 'BUSY',
    languages: ['en'],
    interests: ['books'],
    voiceRatePerMinuteCents: 80,
    applicationBio: 'Thoughtful audio chats.',
  });
  const eve = await upsertUser({
    email: 'eve@example.com',
    displayName: 'Eve',
    bio: 'Hindi and English. Keep it kind.',
    language: 'hi',
    country: 'IN',
    gender: 'FEMALE',
    ratePerMinuteCents: 90,
    lastActiveAt: new Date(now - 300_000),
  });
  await upsertHost(eve.id, {
    status: 'PENDING_REVIEW',
    availability: 'OFFLINE',
    languages: ['hi', 'en'],
    interests: ['kindness'],
    applicationBio: 'Hindi and English. Keep it kind.',
  });
  const hidden = await upsertUser({
    email: 'hidden@example.com',
    displayName: 'Hidden Dev User',
    bio: 'Should not appear in discovery',
    language: 'en',
    isDiscoverable: false,
  });
  await upsertHost(hidden.id, {
    status: 'SUSPENDED',
    availability: 'OFFLINE',
    applicationBio: 'Suspended development host',
  });

  console.log({
    admin: admin.email,
    alice: alice.email,
    bob: bob.email,
    carol: carol.email,
    dave: dave.email,
    eve: eve.email,
    hidden: hidden.email,
    note: 'Development seed only. Password ChangeMe123! Alice=caller, Bob=online host.',
  });
  await seedRechargePlans();
}

async function seedRechargePlans() {
  const existing = await prisma.rechargePlan.count();
  if (existing > 0) {
    return;
  }
  await prisma.rechargePlan.createMany({
    data: [
      {
        name: 'Starter',
        priceMinor: 9900,
        walletCreditMinor: 9900,
        coins: 100,
        description: '₹99',
        displayOrder: 1,
      },
      {
        name: 'Plus',
        priceMinor: 19900,
        walletCreditMinor: 19900,
        coins: 220,
        bonusCoins: 20,
        description: '₹199',
        displayOrder: 2,
      },
      {
        name: 'Popular',
        priceMinor: 49900,
        walletCreditMinor: 49900,
        coins: 600,
        bonusCoins: 100,
        description: '₹499',
        displayOrder: 3,
      },
    ],
  });
}

main()
  .then(() => prisma.$disconnect())
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    process.exit(1);
  });
