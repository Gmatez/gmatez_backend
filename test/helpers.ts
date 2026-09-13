import { INestApplication } from '@nestjs/common';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';

export const prisma = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.DATABASE_URL ||
        'postgresql://ubuntu:postgres@127.0.0.1:5432/social_calling_test?schema=public',
    },
  },
});

export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "AuditLog",
      "AnalyticsEvent",
      "AppNotification",
      "DeviceToken",
      "Report",
      "Block",
      "CallEvent",
      "Call",
      "ProviderEvent",
      "Payment",
      "WalletLedgerEntry",
      "Wallet",
      "RefreshToken",
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

export async function closeApp(app?: INestApplication): Promise<void> {
  if (app) {
    await app.close();
  }
  await prisma.$disconnect();
}
