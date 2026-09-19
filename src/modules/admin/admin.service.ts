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

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly payouts: PayoutsService,
    private readonly hosts: HostsService,
    private readonly calling: CallingService,
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

  async setUserStatus(actorId: string, userId: string, status: UserStatus) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: { status },
    });
    await this.audit(actorId, 'user.status', 'user', userId, { status });
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

  setPayoutStatus(actorId: string, payoutId: string, status: PayoutStatus) {
    return this.payouts.adminSetStatus(actorId, payoutId, status);
  }

  listReports(status?: ReportStatus) {
    return this.prisma.report.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
  }

  async resolveReport(actorId: string, reportId: string, status: ReportStatus) {
    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { status },
    });
    await this.audit(actorId, 'report.resolve', 'report', reportId, { status });
    return report;
  }

  async adjustWallet(
    actorId: string,
    userId: string,
    amountCents: number,
    reason: string,
  ) {
    if (amountCents === 0) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Adjustment cannot be zero',
      );
    }
    const type = amountCents > 0 ? 'CREDIT' : 'DEBIT';
    const result = await this.wallet.applyLedger({
      userId,
      type,
      reason: 'ADMIN_ADJUSTMENT',
      amountCents: Math.abs(amountCents),
      idempotencyKey: `admin:${actorId}:${userId}:${Date.now()}:${amountCents}`,
      referenceType: 'admin_adjustment',
      referenceId: actorId,
      metadata: { reason },
    });
    await this.audit(actorId, 'wallet.adjust', 'user', userId, {
      amountCents,
      reason,
    });
    return result.wallet;
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
