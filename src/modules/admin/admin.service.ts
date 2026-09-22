import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  HostStatus,
  HostVerificationStatus,
  PayoutStatus,
  Prisma,
  ReportStatus,
  UserStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { WalletService } from '../wallet/wallet.service';
import { PayoutsService } from '../payouts/payouts.service';
import { HostsService } from '../hosts/hosts.service';
import { CallingService } from '../calling/calling.service';
import { NotificationsService } from '../notifications/notifications.service';

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly payouts: PayoutsService,
    private readonly hosts: HostsService,
    private readonly calling: CallingService,
    private readonly notifications: NotificationsService,
  ) {}

  listUsers(status?: UserStatus, q?: string) {
    const query = q?.trim();
    return this.prisma.user.findMany({
      where: {
        ...(status ? { status } : {}),
        ...(query
          ? {
              OR: [
                { email: { contains: query, mode: 'insensitive' } },
                {
                  profile: {
                    displayName: { contains: query, mode: 'insensitive' },
                  },
                },
              ],
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
        profile: { select: { displayName: true } },
      },
    });
  }

  async getUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        phone: true,
        role: true,
        status: true,
        createdAt: true,
        profile: true,
        hostProfile: true,
        wallet: {
          select: {
            currency: true,
            availableBalanceCents: true,
            heldBalanceCents: true,
          },
        },
      },
    });
    if (!user) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const [calls, payments, reports, payouts] = await Promise.all([
      this.prisma.call.findMany({
        where: { OR: [{ callerId: userId }, { calleeId: userId }] },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.payment.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.report.findMany({
        where: { OR: [{ reporterId: userId }, { reportedId: userId }] },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
      this.prisma.payoutRequest.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 50,
      }),
    ]);
    return { ...user, calls, payments, reports, payouts };
  }

  async getCall(callId: string) {
    const call = await this.prisma.call.findUnique({ where: { id: callId } });
    if (!call) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Call not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return call;
  }

  async setUserStatus(
    actorId: string,
    userId: string,
    status: UserStatus,
    reason?: string,
  ) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { status },
    });
    await this.audit(actorId, 'user.status', 'user', userId, {
      status,
      ...(reason ? { reason } : {}),
    });
    return user;
  }

  listCalls() {
    return this.prisma.call.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  listPayments() {
    return this.prisma.payment.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  listPayouts() {
    return this.payouts.listAll();
  }

  setPayoutStatus(
    actorId: string,
    payoutId: string,
    status: PayoutStatus,
    failureReason?: string,
  ) {
    return this.payouts.adminSetStatus(actorId, payoutId, status, failureReason);
  }

  listReports(status?: ReportStatus) {
    return this.prisma.report.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async resolveReport(
    actorId: string,
    reportId: string,
    status: ReportStatus,
    reason?: string,
  ) {
    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { status },
    });
    await this.audit(actorId, 'report.resolve', 'report', reportId, {
      status,
      ...(reason ? { reason } : {}),
    });
    return report;
  }

  async adjustWallet(
    actorId: string,
    userId: string,
    amountCents: number,
    reason: string,
    idempotencyKey?: string,
  ) {
    if (amountCents === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Adjustment cannot be zero',
      );
    }
    const type = amountCents > 0 ? 'CREDIT' : 'DEBIT';
    const key = idempotencyKey
      ? `admin-adjust:${actorId}:${idempotencyKey}`
      : `admin:${actorId}:${userId}:${Date.now()}:${amountCents}`;
    const result = await this.wallet.applyLedger({
      userId,
      type,
      reason: 'ADMIN_ADJUSTMENT',
      amountCents: Math.abs(amountCents),
      idempotencyKey: key,
      referenceType: 'admin_adjustment',
      referenceId: actorId,
      metadata: { reason },
    });
    if (!result.duplicate) {
      await this.audit(actorId, 'wallet.adjust', 'user', userId, {
        amountCents,
        reason,
        idempotencyKey: key,
      });
    }
    return { ...result.wallet, duplicate: result.duplicate };
  }

  async sendNotification(
    actorId: string,
    input: {
      userId: string;
      title: string;
      body: string;
      deepLink?: string;
      type?: string;
      idempotencyKey: string;
    },
  ) {
    const key = input.idempotencyKey.trim();
    const existing = await this.prisma.auditLog.findFirst({
      where: {
        action: 'notification.send',
        metadata: { path: ['idempotencyKey'], equals: key },
      },
    });
    if (existing) {
      const metadata = existing.metadata as { notificationId?: string } | null;
      return {
        duplicate: true,
        notificationId: metadata?.notificationId ?? null,
      };
    }
    const user = await this.prisma.user.findUnique({
      where: { id: input.userId },
      select: { id: true, status: true },
    });
    if (!user) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (user.status === 'DELETED') {
      throw new AppError(
        ErrorCodes.ACCOUNT_DELETED,
        'Cannot notify a deleted account',
        HttpStatus.CONFLICT,
      );
    }
    const type = input.type?.trim() || 'system';
    if (!/^[a-z0-9_]{2,40}$/.test(type)) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Notification type must be 2-40 lowercase characters',
      );
    }
    if (
      input.deepLink &&
      !/^\/(?!\/)[A-Za-z0-9/_?=&.%-]{0,119}$/.test(input.deepLink)
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Deep link must be an in-app path',
      );
    }
    const created = await this.notifications.notifyUser(
      user.id,
      {
        type,
        title: input.title.trim(),
        body: input.body.trim(),
        ...(input.deepLink ? { data: { deepLink: input.deepLink } } : {}),
      },
      { jobId: `admin-notify:${key}` },
    );
    await this.audit(actorId, 'notification.send', 'user', user.id, {
      idempotencyKey: key,
      notificationId: created?.id ?? null,
      type,
      suppressed: created == null,
    });
    return { duplicate: false, notification: created, suppressed: created == null };
  }

  reconcileWallet(userId: string) {
    return this.wallet.reconcile(userId);
  }

  refundCall(actorId: string, callId: string, reason?: string) {
    return this.calling.refundSettledCall(actorId, callId, reason);
  }

  listAuditLogs(targetType?: string, targetId?: string) {
    return this.prisma.auditLog.findMany({
      where: {
        ...(targetType ? { targetType } : {}),
        ...(targetId ? { targetId } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async overview() {
    const [users, calls, payments, pendingHosts] = await Promise.all([
      this.prisma.user.count(),
      this.prisma.call.count(),
      this.prisma.payment.count({ where: { status: 'SUCCEEDED' } }),
      this.prisma.hostProfile.count({ where: { status: 'PENDING_REVIEW' } }),
    ]);
    return { users, calls, succeededPayments: payments, pendingHosts };
  }

  listHosts(status?: HostStatus) {
    return this.hosts.listForAdmin(status);
  }

  getHost(userId: string) {
    return this.hosts.adminGetHost(userId);
  }

  setHostStatus(
    actorId: string,
    userId: string,
    status: HostStatus,
    reviewNote?: string,
    internalNote?: string,
  ) {
    return this.hosts.adminSetStatus(
      actorId,
      userId,
      status,
      reviewNote,
      internalNote,
    );
  }

  setHostVerification(
    actorId: string,
    userId: string,
    verificationStatus: HostVerificationStatus,
    internalNote?: string,
  ) {
    return this.hosts.adminSetVerification(
      actorId,
      userId,
      verificationStatus,
      internalNote,
    );
  }

  private async audit(
    actorId: string,
    action: string,
    targetType: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await this.prisma.auditLog.create({
      data: {
        actorId,
        action,
        targetType,
        targetId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
    this.logger.log({ actorId, action, targetType, targetId });
  }
}
