import { INestApplication } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog",
      "AnalyticsEvent",
      "AppNotification",
      "NotificationPreference",
      "DeviceToken",
      "Report",
      "Block",
      "Message",
      "Conversation",
      "CallEvent",
      "Call",
      "ProviderEvent",
      "Payment",
      "PayoutRequest",
      "PayoutDestination",
      "WalletLedgerEntry",
      "Wallet",
      "RefreshToken",
      "HostAgreementAcceptance",
      "HostProfile",
      "Profile",
      "User"
    RESTART IDENTITY CASCADE;
  `);
}

export async function createTestApp(): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/** HTTP + Socket.IO on an ephemeral port (for realtime e2e). */
export async function createListeningTestApp(): Promise<{
  app: NestFastifyApplication;
  baseUrl: string;
  wsUrl: string;
}> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );
  app.useWebSocketAdapter(new IoAdapter(app));
  app.setGlobalPrefix('api/v1', { exclude: ['health', 'ready'] });
  await app.listen(0, '127.0.0.1');
  const baseUrl = (await app.getUrl()).replace('0.0.0.0', '127.0.0.1');
  return { app, baseUrl, wsUrl: `${baseUrl}/ws` };
}

export async function closeApp(app?: INestApplication): Promise<void> {
  if (app) {
    await app.close();
  }
  await prisma.$disconnect();
}

/** Register a USER via email/password (test auth path). */
export async function registerUser(
  app: NestFastifyApplication,
  email: string,
  displayName: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/register',
    payload: { email, password: 'ChangeMe123!', displayName },
  });
  expect(res.statusCode).toBe(201);
  return JSON.parse(res.body) as { accessToken: string; refreshToken: string };
}

export async function me(app: NestFastifyApplication, token: string) {
  const res = await app.inject({
    method: 'GET',
    url: '/api/v1/users/me',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as { id: string; email: string; role: string };
}

/** Promote a user to ADMIN (server-side only — no client promotion API). */
export async function promoteAdmin(userId: string) {
  await prisma.user.update({
    where: { id: userId },
    data: { role: 'ADMIN' },
  });
}

/**
 * Register + promote admin. Prefer this over re-login (avoids auth rate limits;
 * JwtAuthGuard loads role from DB on each request).
 */
export async function registerAdmin(
  app: NestFastifyApplication,
  email = 'admin@example.com',
  displayName = 'Admin',
) {
  const registered = await registerUser(app, email, displayName);
  const user = await me(app, registered.accessToken);
  await promoteAdmin(user.id);
  return { ...registered, userId: user.id };
}

/**
 * Legitimate host lifecycle: apply (with agreements + avatar) → admin ACTIVE → optional ONLINE.
 */
export async function activateHost(input: {
  app: NestFastifyApplication;
  hostToken: string;
  adminToken: string;
  hostUserId: string;
  online?: boolean;
  languages?: string[];
  voiceRatePerMinuteCents?: number;
  videoRatePerMinuteCents?: number;
}) {
  const avatar = await input.app.inject({
    method: 'PATCH',
    url: '/api/v1/profiles/me',
    headers: { authorization: `Bearer ${input.hostToken}` },
    payload: {
      avatarUrl: 'https://cdn.example.com/avatars/host.png',
      bio: 'Experienced listener ready to help callers.',
    },
  });
  expect(avatar.statusCode).toBe(200);

  const apply = await input.app.inject({
    method: 'POST',
    url: '/api/v1/hosts/applications',
    headers: { authorization: `Bearer ${input.hostToken}` },
    payload: {
      applicationBio: 'Experienced listener ready to help callers.',
      languages: input.languages ?? ['en'],
      interests: ['support'],
      voiceEnabled: true,
      videoEnabled: true,
      voiceRatePerMinuteCents: input.voiceRatePerMinuteCents ?? 150,
      videoRatePerMinuteCents: input.videoRatePerMinuteCents ?? 250,
      acceptedAgreements: [
        { agreementType: 'HOST_GUIDELINES', version: '1.0' },
        { agreementType: 'TERMS_OF_SERVICE', version: '1.0' },
        { agreementType: 'PRIVACY_POLICY', version: '1.0' },
      ],
    },
  });
  expect(apply.statusCode).toBe(201);

  const approve = await input.app.inject({
    method: 'PATCH',
    url: `/api/v1/admin/hosts/${input.hostUserId}/status`,
    headers: { authorization: `Bearer ${input.adminToken}` },
    payload: { status: 'ACTIVE', reviewNote: 'e2e approve' },
  });
  expect(approve.statusCode).toBe(200);

  if (input.online !== false) {
    const avail = await input.app.inject({
      method: 'POST',
      url: '/api/v1/hosts/me/availability',
      headers: { authorization: `Bearer ${input.hostToken}` },
      payload: { availability: 'ONLINE' },
    });
    expect(avail.statusCode).toBe(201);
  }
}
