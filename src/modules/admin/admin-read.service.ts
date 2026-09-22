import { HttpStatus, Injectable } from '@nestjs/common';
import {
  CallStatus,
  CallType,
  HostAvailability,
  HostStatus,
  HostVerificationStatus,
  LedgerReason,
  NotificationStatus,
  PaymentStatus,
  PayoutStatus,
  Prisma,
  ReportReason,
  ReportStatus,
  UserStatus,
} from '@prisma/client';
import { AppConfigService } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { QueueService } from '../../queue/queue.service';
import { RedisService } from '../../redis/redis.service';
import { rtcChannelName } from '../../providers/calling/rtc-identity';
import { computeCreatorEarningCents } from '../calling/call-state.machine';
import { CallingService } from '../calling/calling.service';
import { HostCompletenessService } from '../hosts/host-completeness.service';
import { PayoutsService } from '../payouts/payouts.service';
import { WalletService } from '../wallet/wallet.service';
import {
  assertOneOf,
  callSettlementWhere,
  createdAtRange,
  fillCountDays,
  isUuid,
  maskDestinationDetails,
  maskSecret,
  parseAnalyticsDays,
  parseDateBound,
  parsePageQuery,
  startOfUtcDay,
  utcDayKey,
  type PageQuery,
} from './admin-query.util';
import { classifyProvider } from './admin-query.util';

export type PageResult<T> = {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
};

const USER_STATUSES = ['ACTIVE', 'SUSPENDED', 'DELETED'] as const;
const HOST_STATUSES = ['PENDING_REVIEW', 'ACTIVE', 'SUSPENDED', 'REJECTED'] as const;
const HOST_AVAILABILITY = ['OFFLINE', 'ONLINE', 'BUSY', 'PAUSED'] as const;
const CALL_STATUSES = [
  'INITIATED',
  'RINGING',
  'ACCEPTED',
  'CONNECTING',
  'CONNECTED',
  'REJECTED',
  'TIMEOUT',
  'CANCELLED',
  'FAILED',
  'ENDED',
] as const;
const PAYMENT_STATUSES = [
  'PENDING',
  'REQUIRES_ACTION',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
] as const;
const PAYOUT_STATUSES = [
  'REQUESTED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
  'REJECTED',
] as const;
const REPORT_STATUSES = ['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED'] as const;

const profileName = {
  select: { displayName: true, avatarUrl: true, lastActiveAt: true },
} as const;

@Injectable()
export class AdminReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: AppConfigService,
    private readonly wallet: WalletService,
    private readonly payouts: PayoutsService,
    private readonly calling: CallingService,
    private readonly completeness: HostCompletenessService,
    private readonly redis: RedisService,
    private readonly queue: QueueService,
  ) {}

  async dashboard() {
    const startToday = startOfUtcDay(0);
    const sevenDays = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      usersByStatus,
      hostsByStatus,
      hostsByAvailability,
      callsByStatus,
      callsByType,
      paymentsByStatus,
      payoutsByStatus,
      reportsByStatus,
      walletAgg,
      ledger,
      pendingPayouts,
      newUsersToday,
      newUsers7d,
      recentlyActive,
      onlineHosts,
    ] = await Promise.all([
      this.prisma.user.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.hostProfile.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.hostProfile.groupBy({
        by: ['availability'],
        _count: { _all: true },
      }),
      this.prisma.call.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.call.groupBy({ by: ['callType'], _count: { _all: true } }),
      this.prisma.payment.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.payoutRequest.groupBy({
        by: ['status'],
        _count: { _all: true },
        _sum: { amountCents: true },
      }),
      this.prisma.report.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.wallet.aggregate({
        _sum: { availableBalanceCents: true, heldBalanceCents: true },
        _count: { _all: true },
      }),
      this.prisma.walletLedgerEntry.groupBy({
        by: ['reason', 'type'],
        _sum: { amountCents: true },
      }),
      this.prisma.payoutRequest.aggregate({
        where: { status: { in: ['REQUESTED', 'PROCESSING'] } },
        _sum: { amountCents: true },
        _count: { _all: true },
      }),
      this.prisma.user.count({ where: { createdAt: { gte: startToday } } }),
      this.prisma.user.count({ where: { createdAt: { gte: sevenDays } } }),
      this.prisma.profile.count({ where: { lastActiveAt: { gte: dayAgo } } }),
      this.prisma.hostProfile.count({
        where: { status: 'ACTIVE', availability: 'ONLINE' },
      }),
    ]);

    const money = this.moneyFromLedger(ledger);
    const users = this.countRecord(usersByStatus, USER_STATUSES);
    const hosts = this.countRecord(hostsByStatus, HOST_STATUSES);
    const calls = this.countRecord(callsByStatus, CALL_STATUSES);
    return {
      generatedAt: new Date().toISOString(),
      creatorShareBps: this.config.get('CREATOR_SHARE_BPS'),
      currencyNote:
        'Amounts are integer minor units from the ledger. Do not rescale them.',
      users: {
        total: sumValues(users),
        byStatus: users,
        newToday: newUsersToday,
        newLast7Days: newUsers7d,
        recentlyActive24h: recentlyActive,
      },
      hosts: {
        total: sumValues(hosts),
        byStatus: hosts,
        byAvailability: this.countRecord(hostsByAvailability, HOST_AVAILABILITY),
        online: onlineHosts,
      },
      calls: {
        total: sumValues(calls),
        byStatus: calls,
        byType: this.countRecord(callsByType, ['VOICE', 'VIDEO'] as const),
        active: calls.INITIATED + calls.RINGING + calls.ACCEPTED + calls.CONNECTING + calls.CONNECTED,
      },
      payments: {
        byStatus: this.countRecord(paymentsByStatus, PAYMENT_STATUSES),
      },
      payouts: {
        byStatus: Object.fromEntries(
          PAYOUT_STATUSES.map((status) => {
            const row = payoutsByStatus.find((item) => item.status === status);
            return [
              status,
              {
                count: row?._count._all ?? 0,
                amountCents: row?._sum.amountCents ?? 0,
              },
            ];
          }),
        ),
        pendingCount: pendingPayouts._count._all,
        pendingAmountCents: pendingPayouts._sum.amountCents ?? 0,
        rules: this.payouts.rules(),
      },
      reports: {
        byStatus: this.countRecord(reportsByStatus, REPORT_STATUSES),
      },
      financial: {
        walletCount: walletAgg._count._all,
        availableBalanceCents: walletAgg._sum.availableBalanceCents ?? 0,
        heldBalanceCents: walletAgg._sum.heldBalanceCents ?? 0,
        ...money,
      },
    };
  }

  async analytics(daysRaw?: string) {
    const days = this.parse(() => parseAnalyticsDays(daysRaw));
    const from = startOfUtcDay(days - 1);
    const [callRows, userRows, ledgerRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{ day: Date; status: string; call_type: string; count: number }>
      >`
        SELECT date_trunc('day', "createdAt") AS day,
               status::text AS status,
               "callType"::text AS call_type,
               COUNT(*)::int AS count
        FROM "Call"
        WHERE "createdAt" >= ${from}
        GROUP BY 1, 2, 3
        ORDER BY 1
      `,
      this.prisma.$queryRaw<Array<{ day: Date; count: number }>>`
        SELECT date_trunc('day', "createdAt") AS day,
               COUNT(*)::int AS count
        FROM "User"
        WHERE "createdAt" >= ${from}
        GROUP BY 1
        ORDER BY 1
      `,
      this.prisma.$queryRaw<
        Array<{ day: Date; reason: string; type: string; amount: number }>
      >`
        SELECT date_trunc('day', "createdAt") AS day,
               reason::text AS reason,
               type::text AS type,
               COALESCE(SUM("amountCents"), 0)::int AS amount
        FROM "WalletLedgerEntry"
        WHERE "createdAt" >= ${from}
        GROUP BY 1, 2, 3
        ORDER BY 1
      `,
    ]);

    const callsPerDay = new Map<
      string,
      {
        date: string;
        total: number;
        ended: number;
        failed: number;
        cancelled: number;
        timeout: number;
        missed: number;
        voice: number;
        video: number;
      }
    >();
    for (let index = 0; index < days; index += 1) {
      const date = new Date(from);
      date.setUTCDate(from.getUTCDate() + index);
      const key = utcDayKey(date);
      callsPerDay.set(key, {
        date: key,
        total: 0,
        ended: 0,
        failed: 0,
        cancelled: 0,
        timeout: 0,
        missed: 0,
        voice: 0,
        video: 0,
      });
    }
    for (const row of callRows) {
      const bucket = callsPerDay.get(utcDayKey(new Date(row.day)));
      if (!bucket) {
        continue;
      }
      const count = Number(row.count);
      bucket.total += count;
      if (row.status === 'ENDED') bucket.ended += count;
      if (row.status === 'FAILED') bucket.failed += count;
      if (row.status === 'CANCELLED') bucket.cancelled += count;
      if (row.status === 'TIMEOUT') bucket.timeout += count;
      if (row.status === 'REJECTED') bucket.missed += count;
      if (row.call_type === 'VOICE') bucket.voice += count;
      if (row.call_type === 'VIDEO') bucket.video += count;
    }

    const registrations = new Map<string, number>();
    for (const row of userRows) {
      registrations.set(utcDayKey(new Date(row.day)), Number(row.count));
    }

    type MoneyDay = {
      date: string;
      depositsCents: number;
      callChargesCents: number;
      creatorEarningsCents: number;
      refundsCents: number;
      platformShareCents: number;
    };
    const money = new Map<string, MoneyDay>();
    for (const row of fillCountDays(from, days, new Map())) {
      money.set(row.date, {
        date: row.date,
        depositsCents: 0,
        callChargesCents: 0,
        creatorEarningsCents: 0,
        refundsCents: 0,
        platformShareCents: 0,
      });
    }
    for (const row of ledgerRows) {
      const bucket = money.get(utcDayKey(new Date(row.day)));
      if (!bucket) {
        continue;
      }
      const amount = Number(row.amount);
      if (row.reason === 'PAYMENT_TOPUP' && row.type === 'CREDIT') {
        bucket.depositsCents += amount;
      }
      if (row.reason === 'CALL_CHARGE' && row.type === 'DEBIT') {
        bucket.callChargesCents += amount;
      }
      if (row.reason === 'CREATOR_EARNING' && row.type === 'CREDIT') {
        bucket.creatorEarningsCents += amount;
      }
      if (row.reason === 'CALL_REFUND' && row.type === 'CREDIT') {
        bucket.refundsCents += amount;
      }
    }
    for (const bucket of money.values()) {
      bucket.platformShareCents =
        bucket.callChargesCents - bucket.creatorEarningsCents;
    }

    return {
      from: from.toISOString(),
      days,
      creatorShareBps: this.config.get('CREATOR_SHARE_BPS'),
      callsPerDay: [...callsPerDay.values()],
      registrationsPerDay: fillCountDays(from, days, registrations),
      moneyPerDay: [...money.values()],
    };
  }

  async alerts() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const [
      pendingHostApplications,
      openReports,
      payoutRequests,
      failedPayments24h,
      failedNotifications24h,
    ] = await Promise.all([
      this.prisma.hostProfile.count({ where: { status: 'PENDING_REVIEW' } }),
      this.prisma.report.count({
        where: { status: { in: ['OPEN', 'UNDER_REVIEW'] } },
      }),
      this.prisma.payoutRequest.count({
        where: { status: { in: ['REQUESTED', 'PROCESSING'] } },
      }),
      this.prisma.payment.count({
        where: { status: 'FAILED', createdAt: { gte: since } },
      }),
      this.prisma.appNotification.count({
        where: { status: 'FAILED', createdAt: { gte: since } },
      }),
    ]);
    return {
      pendingHostApplications,
      openReports,
      payoutRequests,
      failedPayments24h,
      failedNotifications24h,
      total:
        pendingHostApplications +
        openReports +
        payoutRequests +
        failedPayments24h +
        failedNotifications24h,
    };
  }

  async search(rawQuery?: string) {
    const q = rawQuery?.trim() ?? '';
    if (q.length < 2) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Search requires at least 2 characters',
      );
    }
    const uuid = isUuid(q) ? q : undefined;
    const contains = { contains: q, mode: 'insensitive' as const };
    const [users, hosts, calls, payments, payouts, reports] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          OR: [
            ...(uuid ? [{ id: uuid }] : []),
            { email: contains },
            { phone: contains },
            { profile: { displayName: contains } },
          ],
        },
        take: 8,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          email: true,
          phone: true,
          status: true,
          profile: { select: { displayName: true } },
        },
      }),
      this.prisma.hostProfile.findMany({
        where: {
          OR: [
            ...(uuid ? [{ userId: uuid }] : []),
            { user: { email: contains } },
            { user: { phone: contains } },
            { user: { profile: { displayName: contains } } },
          ],
        },
        take: 8,
        orderBy: { updatedAt: 'desc' },
        select: {
          userId: true,
          status: true,
          availability: true,
          user: {
            select: {
              phone: true,
              profile: { select: { displayName: true } },
            },
          },
        },
      }),
      uuid
        ? this.prisma.call.findMany({
            where: {
              OR: [{ id: uuid }, { callerId: uuid }, { calleeId: uuid }],
            },
            take: 8,
            orderBy: { createdAt: 'desc' },
            select: {
              id: true,
              status: true,
              callType: true,
              createdAt: true,
            },
          })
        : Promise.resolve([]),
      this.prisma.payment.findMany({
        where: {
          OR: [
            ...(uuid ? [{ id: uuid }] : []),
            { providerPaymentId: contains },
          ],
        },
        take: 8,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          status: true,
          amountCents: true,
          currency: true,
          provider: true,
          createdAt: true,
        },
      }),
      uuid
        ? this.prisma.payoutRequest.findMany({
            where: { OR: [{ id: uuid }, { userId: uuid }] },
            take: 8,
            select: {
              id: true,
              status: true,
              amountCents: true,
              userId: true,
              createdAt: true,
            },
          })
        : Promise.resolve([]),
      uuid
        ? this.prisma.report.findMany({
            where: {
              OR: [{ id: uuid }, { reporterId: uuid }, { reportedId: uuid }],
            },
            take: 8,
            select: {
              id: true,
              status: true,
              reason: true,
              createdAt: true,
            },
          })
        : Promise.resolve([]),
    ]);
    return { users, hosts, calls, payments, payouts, reports };
  }

  async listUsers(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const status = this.parse(() =>
      assertOneOf(query.status, USER_STATUSES, 'status'),
    );
    const from = this.parse(() => parseDateBound(query.from, 'from'));
    const to = this.parse(() => parseDateBound(query.to, 'to'));
    const createdAt = createdAtRange(from, to);
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      ...(status ? { status: status as UserStatus } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(q
        ? {
            OR: [
              ...(isUuid(q) ? [{ id: q }] : []),
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q, mode: 'insensitive' } },
              {
                profile: {
                  displayName: { contains: q, mode: 'insensitive' },
                },
              },
            ],
          }
        : {}),
    };
    const sort = this.sort(query.sort, query.dir, ['createdAt', 'email', 'status'] as const, 'createdAt');
    const [total, items] = await this.prisma.$transaction([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        orderBy: sort,
        skip: page.skip,
        take: page.take,
        select: {
          id: true,
          email: true,
          phone: true,
          role: true,
          status: true,
          createdAt: true,
          profile: profileName,
          hostProfile: {
            select: { status: true, availability: true, verificationStatus: true },
          },
          wallet: {
            select: {
              currency: true,
              availableBalanceCents: true,
              heldBalanceCents: true,
            },
          },
        },
      }),
    ]);
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async listHosts(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const status = this.parse(() =>
      assertOneOf(query.status, HOST_STATUSES, 'status'),
    );
    const availability = this.parse(() =>
      assertOneOf(query.availability, HOST_AVAILABILITY, 'availability'),
    );
    const verificationStatus = this.parse(() =>
      assertOneOf(
        query.verificationStatus,
        ['NOT_REQUIRED', 'PENDING', 'VERIFIED', 'REJECTED'] as const,
        'verificationStatus',
      ),
    );
    const q = query.q?.trim();
    const incomplete = query.incomplete === 'true';
    const where: Prisma.HostProfileWhereInput = {
      ...(status ? { status: status as HostStatus } : {}),
      ...(availability ? { availability: availability as HostAvailability } : {}),
      ...(verificationStatus
        ? { verificationStatus: verificationStatus as HostVerificationStatus }
        : {}),
      ...(incomplete
        ? {
            OR: [
              { languages: { isEmpty: true } },
              { applicationBio: '' },
              { agreementAcceptances: { none: {} } },
              { verificationStatus: { in: ['PENDING', 'REJECTED'] } },
              { user: { profile: { OR: [{ avatarUrl: null }, { avatarUrl: '' }] } } },
            ],
          }
        : {}),
      ...(q
        ? {
            user: {
              OR: [
                ...(isUuid(q) ? [{ id: q }] : []),
                { email: { contains: q, mode: 'insensitive' } },
                { phone: { contains: q, mode: 'insensitive' } },
                { profile: { displayName: { contains: q, mode: 'insensitive' } } },
              ],
            },
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.hostProfile.count({ where }),
      this.prisma.hostProfile.findMany({
        where,
        orderBy: { updatedAt: query.dir === 'asc' ? 'asc' : 'desc' },
        skip: page.skip,
        take: page.take,
        include: {
          user: {
            select: {
              id: true,
              email: true,
              phone: true,
              status: true,
              profile: true,
            },
          },
          agreementAcceptances: {
            select: { agreementType: true, version: true, acceptedAt: true },
          },
        },
      }),
    ]);
    const items = rows.map((host) => ({
      ...host,
      completeness: this.completeness.evaluateSnapshot({
        profile: host.user.profile,
        host,
        acceptedKeys: new Set(
          host.agreementAcceptances.map(
            (row) => `${row.agreementType}:${row.version}`,
          ),
        ),
      }),
    }));
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async listCalls(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const status = this.parse(() =>
      assertOneOf(query.status, CALL_STATUSES, 'status'),
    );
    const callType = this.parse(() =>
      assertOneOf(query.callType, ['VOICE', 'VIDEO'] as const, 'callType'),
    );
    const settlement = this.parse(() =>
      assertOneOf(
        query.settlement,
        ['PENDING', 'SETTLED', 'NOT_APPLICABLE'] as const,
        'settlement',
      ),
    );
    const from = this.parse(() => parseDateBound(query.from, 'from'));
    const to = this.parse(() => parseDateBound(query.to, 'to'));
    const userId = this.optionalUuid(query.userId, 'userId');
    const hostId = this.optionalUuid(query.hostId, 'hostId');
    const q = query.q?.trim();
    const createdAt = createdAtRange(from, to);
    const where: Prisma.CallWhereInput = {
      AND: [
        status ? { status: status as CallStatus } : {},
        callType ? { callType: callType as CallType } : {},
        callSettlementWhere(settlement) ?? {},
        createdAt ? { createdAt } : {},
        userId ? { OR: [{ callerId: userId }, { calleeId: userId }] } : {},
        hostId ? { calleeId: hostId } : {},
        q
          ? isUuid(q)
            ? { OR: [{ id: q }, { callerId: q }, { calleeId: q }] }
            : {
                OR: [
                  { caller: { profile: { displayName: { contains: q, mode: 'insensitive' } } } },
                  { callee: { profile: { displayName: { contains: q, mode: 'insensitive' } } } },
                ],
              }
          : {},
      ],
    };
    const sortField = ['createdAt', 'status', 'billedAmountCents'].includes(query.sort ?? '')
      ? (query.sort as 'createdAt' | 'status' | 'billedAmountCents')
      : 'createdAt';
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.call.count({ where }),
      this.prisma.call.findMany({
        where,
        orderBy: { [sortField]: query.dir === 'asc' ? 'asc' : 'desc' },
        skip: page.skip,
        take: page.take,
        include: {
          caller: { select: { id: true, phone: true, profile: { select: { displayName: true } } } },
          callee: { select: { id: true, phone: true, profile: { select: { displayName: true } } } },
        },
      }),
    ]);
    const share = this.config.get('CREATOR_SHARE_BPS');
    const items = rows.map((call) => this.presentCall(call, share));
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async getCall(callId: string) {
    const call = await this.prisma.call.findUnique({
      where: { id: callId },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        caller: {
          select: {
            id: true,
            email: true,
            phone: true,
            status: true,
            profile: { select: { displayName: true, avatarUrl: true } },
          },
        },
        callee: {
          select: {
            id: true,
            email: true,
            phone: true,
            status: true,
            profile: { select: { displayName: true, avatarUrl: true } },
          },
        },
      },
    });
    if (!call) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Call not found', HttpStatus.NOT_FOUND);
    }
    const share = this.config.get('CREATOR_SHARE_BPS');
    const refund = await this.prisma.walletLedgerEntry.findFirst({
      where: { referenceType: 'call', referenceId: callId, reason: 'CALL_REFUND' },
      select: { id: true, amountCents: true, createdAt: true },
    });
    const presented = this.presentCall(call, share);
    return {
      ...presented,
      heldAmountCents: call.heldAmountCents,
      settlementAppliedAt: call.settlementAppliedAt,
      callerHeartbeatAt: call.callerHeartbeatAt,
      calleeHeartbeatAt: call.calleeHeartbeatAt,
      version: call.version,
      endReason: call.endReason,
      caller: call.caller,
      callee: call.callee,
      events: call.events.map((event) => ({
        id: event.id,
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
        actorId: event.actorId,
        source: event.source,
        note: event.note,
        createdAt: event.createdAt,
      })),
      refunded: Boolean(refund),
      refund: refund,
      idempotencyKey: call.idempotencyKey,
      updatedAt: call.updatedAt,
      rtc: {
        channelName: rtcChannelName(call.id),
        provider: call.provider,
        providerSessionId: call.providerSessionId,
        tokenExposed: false,
      },
    };
  }

  async listPayments(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const status = this.parse(() =>
      assertOneOf(query.status, PAYMENT_STATUSES, 'status'),
    );
    const from = this.parse(() => parseDateBound(query.from, 'from'));
    const to = this.parse(() => parseDateBound(query.to, 'to'));
    const provider = query.provider?.trim();
    const q = query.q?.trim();
    const createdAt = createdAtRange(from, to);
    const where: Prisma.PaymentWhereInput = {
      ...(status ? { status: status as PaymentStatus } : {}),
      ...(provider ? { provider } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(q
        ? {
            OR: [
              ...(isUuid(q) ? [{ id: q }, { userId: q }] : []),
              { providerPaymentId: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payment.count({ where }),
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: query.dir === 'asc' ? 'asc' : 'desc' },
        skip: page.skip,
        take: page.take,
        select: this.paymentSelect(),
      }),
    ]);
    return {
      items: rows,
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async getPayment(id: string) {
    const payment = await this.prisma.payment.findUnique({
      where: { id },
      select: this.paymentSelect(),
    });
    if (!payment) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Payment not found', HttpStatus.NOT_FOUND);
    }
    const ledger = await this.prisma.walletLedgerEntry.findMany({
      where: { referenceType: 'payment', referenceId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        type: true,
        reason: true,
        amountCents: true,
        balanceAfterCents: true,
        createdAt: true,
      },
    });
    return {
      ...payment,
      ledger,
      webhookPayloadExposed: false,
    };
  }

  async listPayouts(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const status = this.parse(() =>
      assertOneOf(query.status, PAYOUT_STATUSES, 'status'),
    );
    const from = this.parse(() => parseDateBound(query.from, 'from'));
    const to = this.parse(() => parseDateBound(query.to, 'to'));
    const q = query.q?.trim();
    const createdAt = createdAtRange(from, to);
    const where: Prisma.PayoutRequestWhereInput = {
      ...(status ? { status: status as PayoutStatus } : {}),
      ...(createdAt ? { createdAt } : {}),
      ...(q
        ? isUuid(q)
          ? { OR: [{ id: q }, { userId: q }] }
          : {
              user: {
                OR: [
                  { email: { contains: q, mode: 'insensitive' } },
                  { phone: { contains: q, mode: 'insensitive' } },
                  { profile: { displayName: { contains: q, mode: 'insensitive' } } },
                ],
              },
            }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.payoutRequest.count({ where }),
      this.prisma.payoutRequest.findMany({
        where,
        orderBy: { createdAt: query.dir === 'asc' ? 'asc' : 'desc' },
        skip: page.skip,
        take: page.take,
        include: {
          user: {
            select: {
              id: true,
              phone: true,
              profile: { select: { displayName: true } },
            },
          },
          destination: true,
        },
      }),
    ]);
    return {
      items: rows.map((row) => this.presentPayout(row)),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async getPayout(id: string) {
    const payout = await this.prisma.payoutRequest.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            phone: true,
            status: true,
            profile: { select: { displayName: true } },
            hostProfile: { select: { status: true, availability: true } },
          },
        },
        destination: true,
      },
    });
    if (!payout) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Payout not found', HttpStatus.NOT_FOUND);
    }
    const audit = await this.prisma.auditLog.findMany({
      where: { targetType: 'payout', targetId: id },
      orderBy: { createdAt: 'asc' },
      include: { actor: { select: { id: true, email: true } } },
    });
    return {
      ...this.presentPayout(payout),
      user: payout.user,
      audit,
      rules: this.payouts.rules(),
    };
  }

  async earnings() {
    const ledger = await this.prisma.walletLedgerEntry.groupBy({
      by: ['reason', 'type'],
      _sum: { amountCents: true },
    });
    const reversals = await this.prisma.walletLedgerEntry.aggregate({
      where: {
        reason: 'ADMIN_ADJUSTMENT',
        type: 'DEBIT',
        metadata: { path: ['reversalOf'], equals: 'CREATOR_EARNING' },
      },
      _sum: { amountCents: true },
    });
    const paid = await this.prisma.payoutRequest.aggregate({
      where: { status: 'COMPLETED' },
      _sum: { amountCents: true },
      _count: { _all: true },
    });
    const pending = await this.prisma.payoutRequest.aggregate({
      where: { status: { in: ['REQUESTED', 'PROCESSING'] } },
      _sum: { amountCents: true },
      _count: { _all: true },
    });
    const money = this.moneyFromLedger(ledger);
    const earningReversalsCents = reversals._sum.amountCents ?? 0;
    return {
      creatorShareBps: this.config.get('CREATOR_SHARE_BPS'),
      ...money,
      earningReversalsCents,
      netCreatorEarningsCents: money.creatorEarningsCents - earningReversalsCents,
      paidOutCents: paid._sum.amountCents ?? 0,
      paidOutCount: paid._count._all,
      pendingPayoutCents: pending._sum.amountCents ?? 0,
      pendingPayoutCount: pending._count._all,
      rules: this.payouts.rules(),
    };
  }

  async listWallets(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const q = query.q?.trim();
    const where: Prisma.WalletWhereInput = q
      ? {
          user: {
            OR: [
              ...(isUuid(q) ? [{ id: q }] : []),
              { email: { contains: q, mode: 'insensitive' } },
              { phone: { contains: q, mode: 'insensitive' } },
              { profile: { displayName: { contains: q, mode: 'insensitive' } } },
            ],
          },
        }
      : {};
    const [total, items] = await this.prisma.$transaction([
      this.prisma.wallet.count({ where }),
      this.prisma.wallet.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: page.skip,
        take: page.take,
        select: {
          id: true,
          userId: true,
          currency: true,
          availableBalanceCents: true,
          heldBalanceCents: true,
          updatedAt: true,
          user: {
            select: {
              email: true,
              phone: true,
              status: true,
              profile: { select: { displayName: true } },
            },
          },
        },
      }),
    ]);
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  ledger(userId: string, limitRaw?: string, cursor?: string) {
    const limit = this.parse(() => {
      if (!limitRaw) return 25;
      if (!/^\d+$/.test(limitRaw)) throw new Error('limit must be an integer');
      const value = Number(limitRaw);
      if (value < 1 || value > 100) throw new Error('limit must be between 1 and 100');
      return value;
    });
    return this.wallet.listLedger(userId, limit, cursor || undefined);
  }

  async blocks(userId: string) {
    const [initiated, received] = await Promise.all([
      this.prisma.block.findMany({
        where: { blockerId: userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          blocked: {
            select: { id: true, profile: { select: { displayName: true } } },
          },
        },
      }),
      this.prisma.block.findMany({
        where: { blockedId: userId },
        orderBy: { createdAt: 'desc' },
        take: 100,
        include: {
          blocker: {
            select: { id: true, profile: { select: { displayName: true } } },
          },
        },
      }),
    ]);
    return { initiated, received };
  }

  async listReports(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const status = this.parse(() =>
      assertOneOf(query.status, REPORT_STATUSES, 'status'),
    );
    const reason = this.parse(() =>
      assertOneOf(
        query.reason,
        ['HARASSMENT', 'SPAM', 'INAPPROPRIATE_CONTENT', 'FRAUD', 'OTHER'] as const,
        'reason',
      ),
    );
    const from = this.parse(() => parseDateBound(query.from, 'from'));
    const to = this.parse(() => parseDateBound(query.to, 'to'));
    const createdAt = createdAtRange(from, to);
    const where: Prisma.ReportWhereInput = {
      ...(status ? { status: status as ReportStatus } : {}),
      ...(reason ? { reason: reason as ReportReason } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.report.count({ where }),
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: query.dir === 'asc' ? 'asc' : 'desc' },
        skip: page.skip,
        take: page.take,
        include: {
          reporter: { select: { id: true, profile: { select: { displayName: true } } } },
          reported: { select: { id: true, profile: { select: { displayName: true } } } },
        },
      }),
    ]);
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async getReport(id: string) {
    const report = await this.prisma.report.findUnique({
      where: { id },
      include: {
        reporter: {
          select: {
            id: true,
            email: true,
            phone: true,
            status: true,
            profile: { select: { displayName: true } },
          },
        },
        reported: {
          select: {
            id: true,
            email: true,
            phone: true,
            status: true,
            profile: { select: { displayName: true } },
          },
        },
      },
    });
    if (!report) {
      throw new AppError(ErrorCodes.NOT_FOUND, 'Report not found', HttpStatus.NOT_FOUND);
    }
    const audit = await this.prisma.auditLog.findMany({
      where: { targetType: 'report', targetId: id },
      orderBy: { createdAt: 'asc' },
    });
    return { ...report, audit };
  }

  async listNotifications(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const status = this.parse(() =>
      assertOneOf(query.status, ['PENDING', 'SENT', 'FAILED'] as const, 'status'),
    );
    const from = this.parse(() => parseDateBound(query.from, 'from'));
    const to = this.parse(() => parseDateBound(query.to, 'to'));
    const userId = this.optionalUuid(query.userId, 'userId');
    const type = query.type?.trim();
    const createdAt = createdAtRange(from, to);
    const where: Prisma.AppNotificationWhereInput = {
      ...(status ? { status: status as NotificationStatus } : {}),
      ...(userId ? { userId } : {}),
      ...(type ? { type } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.appNotification.count({ where }),
      this.prisma.appNotification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: page.skip,
        take: page.take,
        include: {
          user: { select: { id: true, profile: { select: { displayName: true } } } },
        },
      }),
    ]);
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async listDevices(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const userId = this.optionalUuid(query.userId, 'userId');
    const where: Prisma.DeviceTokenWhereInput = userId ? { userId } : {};
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.deviceToken.count({ where }),
      this.prisma.deviceToken.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: page.skip,
        take: page.take,
        select: {
          id: true,
          userId: true,
          platform: true,
          token: true,
          createdAt: true,
          updatedAt: true,
          user: { select: { profile: { select: { displayName: true } } } },
        },
      }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        userId: row.userId,
        platform: row.platform,
        tokenMasked: maskSecret(row.token, 6, 4),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        user: row.user,
        registration: 'REGISTERED',
      })),
      total,
      page: page.page,
      pageSize: page.pageSize,
    };
  }

  async listAudit(query: Record<string, string | undefined>): Promise<PageResult<unknown>> {
    const page = this.page(query.page, query.pageSize);
    const from = this.parse(() => parseDateBound(query.from, 'from'));
    const to = this.parse(() => parseDateBound(query.to, 'to'));
    const actorId = this.optionalUuid(query.actorId, 'actorId');
    const targetId = query.targetId?.trim();
    const targetType = query.targetType?.trim();
    const action = query.action?.trim();
    const createdAt = createdAtRange(from, to);
    const where: Prisma.AuditLogWhereInput = {
      ...(actorId ? { actorId } : {}),
      ...(targetType ? { targetType } : {}),
      ...(targetId ? { targetId } : {}),
      ...(action ? { action: { contains: action, mode: 'insensitive' } } : {}),
      ...(createdAt ? { createdAt } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: query.dir === 'asc' ? 'asc' : 'desc' },
        skip: page.skip,
        take: page.take,
        include: { actor: { select: { id: true, email: true } } },
      }),
    ]);
    return { items, total, page: page.page, pageSize: page.pageSize };
  }

  async systemStatus() {
    let database: 'ok' | 'error' = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'error';
    }
    let redis: 'ok' | 'error' = 'ok';
    try {
      const pong = await this.redis.client.ping();
      if (pong !== 'PONG') redis = 'error';
    } catch {
      redis = 'error';
    }
    const queues = await this.queueHealth();
    const smsLive = this.config.get('OTP_PROVIDER') === 'sms';
    const agoraLive = this.config.get('CALLING_PROVIDER') === 'agora';
    const stripeLive = this.config.get('PAYMENT_PROVIDER') === 'stripe';
    const fcmLive = this.config.get('PUSH_PROVIDER') === 'fcm';
    const smsReady =
      (this.config.get('SMS_PROVIDER') === 'msg91' &&
        Boolean(this.config.get('MSG91_AUTH_KEY')) &&
        Boolean(this.config.get('MSG91_TEMPLATE_ID'))) ||
      (this.config.get('SMS_PROVIDER') === 'twilio' &&
        Boolean(this.config.get('TWILIO_ACCOUNT_SID')) &&
        Boolean(this.config.get('TWILIO_AUTH_TOKEN')) &&
        Boolean(this.config.get('TWILIO_FROM_NUMBER')));
    return {
      environment: this.config.get('NODE_ENV'),
      version: process.env.npm_package_version ?? '0.1.0',
      api: 'ok',
      database,
      redis,
      queues,
      creatorShareBps: this.config.get('CREATOR_SHARE_BPS'),
      providers: {
        sms: {
          mode: smsLive ? 'live' : 'mock',
          ...classifyProvider({ mode: smsLive ? 'live' : 'mock', credentialsPresent: smsReady }),
        },
        agora: {
          mode: agoraLive ? 'live' : 'mock',
          ...classifyProvider({
            mode: agoraLive ? 'live' : 'mock',
            credentialsPresent:
              Boolean(this.config.get('AGORA_APP_ID')) &&
              Boolean(this.config.get('AGORA_APP_CERTIFICATE')),
          }),
        },
        stripe: {
          mode: stripeLive ? 'live' : 'mock',
          ...classifyProvider({
            mode: stripeLive ? 'live' : 'mock',
            credentialsPresent: Boolean(this.config.get('STRIPE_SECRET_KEY')),
          }),
        },
        fcm: {
          mode: fcmLive ? 'live' : 'mock',
          ...classifyProvider({
            mode: fcmLive ? 'live' : 'mock',
            credentialsPresent: Boolean(this.config.get('FIREBASE_SERVICE_ACCOUNT_JSON')),
          }),
        },
        payout: {
          mode: 'unconfigured',
          status: 'CONFIG_REQUIRED' as const,
          code: 'PAYOUT_PROVIDER_CONFIG_REQUIRED',
          verification: 'NOT_APPLICABLE' as const,
          ...this.payouts.rules(),
        },
      },
    };
  }

  private async queueHealth() {
    try {
      const [notifications, callLifecycle] = await Promise.all([
        this.queue.notifications.getJobCounts('waiting', 'active', 'failed'),
        this.queue.callLifecycle.getJobCounts('waiting', 'active', 'failed'),
      ]);
      return {
        status: 'ok' as const,
        notifications,
        callLifecycle,
      };
    } catch {
      return { status: 'error' as const, notifications: null, callLifecycle: null };
    }
  }

  private presentCall(
    call: {
      id: string;
      callerId: string;
      calleeId: string;
      callType: CallType;
      status: CallStatus;
      provider: string;
      providerSessionId: string;
      ratePerMinuteCents: number;
      billedSeconds: number;
      billedAmountCents: number;
      connectedAt: Date | null;
      endedAt: Date | null;
      endReason: string | null;
      settlementAppliedAt: Date | null;
      createdAt: Date;
      caller?: { id: string; phone: string | null; profile: { displayName: string } | null };
      callee?: { id: string; phone: string | null; profile: { displayName: string } | null };
    },
    creatorShareBps: number,
  ) {
    const creatorEarningCents = call.billedAmountCents
      ? computeCreatorEarningCents(call.billedAmountCents, creatorShareBps)
      : 0;
    return {
      id: call.id,
      callerId: call.callerId,
      calleeId: call.calleeId,
      callerDisplayName: call.caller?.profile?.displayName ?? null,
      calleeDisplayName: call.callee?.profile?.displayName ?? null,
      callType: call.callType,
      status: call.status,
      settlementStatus: this.calling.settlementStatusFor(call as never),
      settlementAppliedAt: call.settlementAppliedAt,
      provider: call.provider,
      providerSessionId: call.providerSessionId,
      rtcChannelName: rtcChannelName(call.id),
      ratePerMinuteCents: call.ratePerMinuteCents,
      billedSeconds: call.billedSeconds,
      billedAmountCents: call.billedAmountCents,
      creatorEarningCents,
      platformFeeCents: Math.max(0, call.billedAmountCents - creatorEarningCents),
      creatorShareBps,
      connectedAt: call.connectedAt,
      endedAt: call.endedAt,
      endReason: call.endReason,
      createdAt: call.createdAt,
    };
  }

  private presentPayout(payout: {
    id: string;
    userId: string;
    destinationId: string | null;
    amountCents: number;
    status: PayoutStatus;
    failureReason: string | null;
    createdAt: Date;
    updatedAt: Date;
    processedAt: Date | null;
    destination?: {
      id: string;
      type: string;
      label: string;
      detailsJson: Prisma.JsonValue;
      isDefault: boolean;
    } | null;
    user?: {
      id: string;
      phone: string | null;
      profile: { displayName: string } | null;
    };
  }) {
    return {
      id: payout.id,
      userId: payout.userId,
      amountCents: payout.amountCents,
      status: payout.status,
      failureReason: payout.failureReason,
      createdAt: payout.createdAt,
      updatedAt: payout.updatedAt,
      processedAt: payout.processedAt,
      hostName: payout.user?.profile?.displayName ?? null,
      hostPhone: payout.user?.phone ?? null,
      destination: payout.destination
        ? {
            id: payout.destination.id,
            type: payout.destination.type,
            label: payout.destination.label,
            isDefault: payout.destination.isDefault,
            detailsMasked: maskDestinationDetails(payout.destination.detailsJson),
          }
        : null,
    };
  }

  private paymentSelect() {
    return {
      id: true,
      userId: true,
      amountCents: true,
      currency: true,
      status: true,
      provider: true,
      providerPaymentId: true,
      failureReason: true,
      createdAt: true,
      updatedAt: true,
      user: {
        select: {
          id: true,
          email: true,
          phone: true,
          profile: { select: { displayName: true } },
        },
      },
    } satisfies Prisma.PaymentSelect;
  }

  private moneyFromLedger(
    rows: Array<{
      reason: LedgerReason;
      type: string;
      _sum: { amountCents: number | null };
    }>,
  ) {
    const amount = (reason: LedgerReason, type: 'CREDIT' | 'DEBIT') =>
      rows.find((row) => row.reason === reason && row.type === type)?._sum
        .amountCents ?? 0;
    const depositsCents = amount('PAYMENT_TOPUP', 'CREDIT');
    const callChargesCents = amount('CALL_CHARGE', 'DEBIT');
    const creatorEarningsCents = amount('CREATOR_EARNING', 'CREDIT');
    const refundsCents = amount('CALL_REFUND', 'CREDIT');
    const adminAdjustmentsCreditCents = amount('ADMIN_ADJUSTMENT', 'CREDIT');
    const adminAdjustmentsDebitCents = amount('ADMIN_ADJUSTMENT', 'DEBIT');
    const payoutDebitsCents = amount('PAYOUT', 'DEBIT');
    return {
      depositsCents,
      callChargesCents,
      creatorEarningsCents,
      platformShareCents: callChargesCents - creatorEarningsCents,
      refundsCents,
      adminAdjustmentsCreditCents,
      adminAdjustmentsDebitCents,
      payoutDebitsCents,
    };
  }

  private countRecord<T extends string>(
    rows: Array<{ _count: { _all: number } }>,
    keys: readonly T[],
  ): Record<T, number> {
    const out = {} as Record<T, number>;
    for (const key of keys) {
      out[key] = 0;
    }
    for (const row of rows) {
      const key = (row as { status?: T; availability?: T; callType?: T }).status
        ?? (row as { availability?: T }).availability
        ?? (row as { callType?: T }).callType;
      if (key && key in out) {
        out[key] = row._count._all;
      }
    }
    return out;
  }

  private page(page?: string, pageSize?: string): PageQuery {
    return this.parse(() => parsePageQuery(page, pageSize));
  }

  private optionalUuid(value: string | undefined, label: string): string | undefined {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    if (!isUuid(trimmed)) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, `${label} must be a UUID`);
    }
    return trimmed;
  }

  private sort<T extends string>(
    sort: string | undefined,
    dir: string | undefined,
    allowed: readonly T[],
    fallback: T,
  ): Record<string, 'asc' | 'desc'> {
    const field = (allowed as readonly string[]).includes(sort ?? '') ? sort! : fallback;
    return { [field]: dir === 'asc' ? 'asc' : 'desc' };
  }

  private parse<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid query';
      throw new AppError(ErrorCodes.VALIDATION_FAILED, message);
    }
  }
}

function sumValues(record: object): number {
  return Object.values(record).reduce(
    (total: number, value) => total + Number(value),
    0,
  );
}
