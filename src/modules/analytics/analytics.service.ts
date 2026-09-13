import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

const ALLOWED_EVENTS = new Set([
  'app_open',
  'profile_view',
  'call_button_tap',
  'wallet_view',
  'discovery_scroll',
]);

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async ingest(
    userId: string,
    eventType: string,
    properties?: Record<string, unknown>,
  ) {
    const type = ALLOWED_EVENTS.has(eventType)
      ? eventType
      : 'unknown_client_event';
    const sanitized = sanitize(properties);
    return this.prisma.analyticsEvent.create({
      data: {
        userId,
        eventType: type,
        properties: sanitized as Prisma.InputJsonValue | undefined,
      },
    });
  }

  async adminSummary() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [events, calls, credits] = await Promise.all([
      this.prisma.analyticsEvent.count({
        where: { createdAt: { gte: since } },
      }),
      this.prisma.call.count({ where: { createdAt: { gte: since } } }),
      this.prisma.walletLedgerEntry.aggregate({
        where: { createdAt: { gte: since }, type: 'CREDIT' },
        _sum: { amountCents: true },
      }),
    ]);
    return {
      window: '24h',
      clientEvents: events,
      calls,
      creditedCents: credits._sum.amountCents ?? 0,
    };
  }
}

function sanitize(properties?: Record<string, unknown>) {
  if (!properties) {
    return undefined;
  }
  const blocked = ['password', 'otp', 'token', 'secret', 'authorization'];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (blocked.some((b) => key.toLowerCase().includes(b))) {
      continue;
    }
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      out[key] = value;
    }
  }
  return out;
}
