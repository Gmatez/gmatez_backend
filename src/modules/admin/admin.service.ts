import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  HostStatus,
  HostVerificationStatus,
  PayoutStatus,
  Prisma,
  ReportStatus,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import { PrismaService } from '../../database/prisma.service';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { WalletService } from '../wallet/wallet.service';
import { PayoutsService } from '../payouts/payouts.service';
import { HostsService } from '../hosts/hosts.service';
import { CallingService } from '../calling/calling.service';
import { NotificationsService } from '../notifications/notifications.service';
import { splitMinuteRate } from './pricing';
import { assertKnownPermission, Permission } from '../../common/permissions';

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
        // Callers only — see AdminReadService.listUsers for why.
        role: 'USER',
        hostProfile: null,
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
        staffRoleId: true,
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
        where: { hostId: userId },
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
    providerTransferId?: string,
  ) {
    return this.payouts.adminSetStatus(
      actorId,
      payoutId,
      status,
      failureReason,
      providerTransferId,
    );
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
    await this.wallet.ensureForUser(userId);
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
      userId?: string;
      audience?: 'USER' | 'ALL_USERS' | 'ALL_HOSTS';
      title: string;
      body: string;
      deepLink?: string;
      type?: string;
      idempotencyKey: string;
    },
  ) {
    const key = input.idempotencyKey.trim();
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
    if (input.audience === 'ALL_USERS' || input.audience === 'ALL_HOSTS') {
      return this.sendAudience(actorId, {
        ...input,
        audience: input.audience,
        type,
        idempotencyKey: key,
      });
    }
    if (!input.userId) {
      throw new AppError(ErrorCodes.VALIDATION_FAILED, 'userId is required');
    }
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
    return {
      duplicate: false,
      notification: created,
      suppressed: created == null,
      delivery: process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        ? 'QUEUED'
        : 'CONFIG_REQUIRED',
    };
  }

  private async sendAudience(
    actorId: string,
    input: {
      audience: 'ALL_USERS' | 'ALL_HOSTS';
      title: string;
      body: string;
      deepLink?: string;
      type?: string;
      idempotencyKey: string;
    },
  ) {
    const existing = await this.prisma.auditLog.findFirst({
      where: {
        action: 'notification.send',
        metadata: { path: ['idempotencyKey'], equals: input.idempotencyKey },
      },
    });
    if (existing) {
      return {
        duplicate: true,
        queued: 0,
        delivery: process.env.FIREBASE_SERVICE_ACCOUNT_JSON
          ? 'QUEUED'
          : 'CONFIG_REQUIRED',
      };
    }
    const users = await this.prisma.user.findMany({
      where: {
        status: 'ACTIVE',
        ...(input.audience === 'ALL_HOSTS'
          ? { hostProfile: { status: 'ACTIVE' } }
          : { role: { in: ['USER', 'ADMIN'] } }),
      },
      select: { id: true },
      take: 200,
    });
    let queued = 0;
    for (const user of users) {
      const created = await this.notifications.notifyUser(
        user.id,
        {
          type: input.type || 'system',
          title: input.title.trim(),
          body: input.body.trim(),
          ...(input.deepLink ? { data: { deepLink: input.deepLink } } : {}),
        },
        { jobId: `admin-notify:${input.idempotencyKey}:${user.id}` },
      );
      if (created) queued += 1;
    }
    await this.audit(actorId, 'notification.send', 'audience', input.audience, {
      idempotencyKey: input.idempotencyKey,
      queued,
    });
    return {
      duplicate: false,
      queued,
      delivery: process.env.FIREBASE_SERVICE_ACCOUNT_JSON
        ? 'QUEUED'
        : 'CONFIG_REQUIRED',
    };
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

  updateHostDetails(
    actorId: string,
    userId: string,
    input: {
      displayName?: string;
      bio?: string;
      languages?: string[];
      interests?: string[];
      voiceEnabled?: boolean;
      videoEnabled?: boolean;
      voiceRatePerMinuteCents?: number;
      videoRatePerMinuteCents?: number;
      identityCardNumber?: string;
      idProofType?: string;
    },
  ) {
    return this.hosts.adminUpdateDetails(actorId, userId, input);
  }

  recordHostAgreements(actorId: string, userId: string) {
    return this.hosts.adminRecordAgreements(actorId, userId);
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

  getPricing() {
    return this.prisma.platformPricing.findUnique({ where: { id: 'default' } });
  }

  async setPricing(
    actorId: string,
    userRatePerMinuteCents: number,
    hostEarningPerMinuteCents: number,
    userVideoRatePerMinuteCents?: number | null,
  ) {
    let split;
    try {
      split = splitMinuteRate(
        userRatePerMinuteCents,
        hostEarningPerMinuteCents,
      );
    } catch (error) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        error instanceof Error ? error.message : 'Invalid pricing',
      );
    }
    if (
      userVideoRatePerMinuteCents != null &&
      (!Number.isInteger(userVideoRatePerMinuteCents) ||
        userVideoRatePerMinuteCents <= 0)
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Video rate must be a positive integer minor amount',
      );
    }
    const previous = await this.prisma.platformPricing.findUnique({
      where: { id: 'default' },
    });
    const next = await this.prisma.platformPricing.upsert({
      where: { id: 'default' },
      update: {
        userRatePerMinuteCents: split.userRatePerMinuteCents,
        hostEarningPerMinuteCents: split.hostEarningPerMinuteCents,
        hostShareBps: split.hostShareBps,
        userVideoRatePerMinuteCents: userVideoRatePerMinuteCents ?? null,
        updatedById: actorId,
      },
      create: {
        id: 'default',
        userRatePerMinuteCents: split.userRatePerMinuteCents,
        hostEarningPerMinuteCents: split.hostEarningPerMinuteCents,
        hostShareBps: split.hostShareBps,
        userVideoRatePerMinuteCents: userVideoRatePerMinuteCents ?? null,
        updatedById: actorId,
      },
    });
    await this.audit(actorId, 'pricing.update', 'platform_pricing', 'default', {
      old: previous
        ? {
            userRatePerMinuteCents: previous.userRatePerMinuteCents,
            hostEarningPerMinuteCents: previous.hostEarningPerMinuteCents,
            hostShareBps: previous.hostShareBps,
            userVideoRatePerMinuteCents: previous.userVideoRatePerMinuteCents,
          }
        : null,
      new: {
        userRatePerMinuteCents: next.userRatePerMinuteCents,
        hostEarningPerMinuteCents: next.hostEarningPerMinuteCents,
        hostShareBps: next.hostShareBps,
        userVideoRatePerMinuteCents: next.userVideoRatePerMinuteCents,
      },
    });
    return {
      ...next,
      platformPerMinuteCents: split.platformPerMinuteCents,
    };
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

  // --- Staff roles (dynamic RBAC) ---------------------------------------

  /** Every internal staff/admin account — the Staff page's list, and also
   *  reused as a lightweight picker (assign a staff role, assign a host
   *  supervisor). */
  listStaffMembers() {
    return this.prisma.user.findMany({
      where: { role: 'ADMIN' },
      orderBy: { email: 'asc' },
      select: {
        id: true,
        email: true,
        status: true,
        createdAt: true,
        staffRole: { select: { id: true, name: true } },
        profile: { select: { displayName: true } },
      },
    });
  }

  async createStaffMember(
    actorId: string,
    input: {
      email: string;
      password: string;
      displayName: string;
      staffRoleId?: string | null;
    },
  ) {
    const email = input.email.trim().toLowerCase();
    if (input.staffRoleId) {
      const role = await this.prisma.staffRole.findUnique({
        where: { id: input.staffRoleId },
      });
      if (!role) {
        throw new AppError(ErrorCodes.NOT_FOUND, 'Staff role not found', HttpStatus.NOT_FOUND);
      }
    }
    const passwordHash = await argon2.hash(input.password, {
      type: argon2.argon2id,
    });
    try {
      const staff = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email,
            passwordHash,
            role: 'ADMIN',
            staffRoleId: input.staffRoleId ?? null,
          },
        });
        await tx.profile.create({
          data: { userId: created.id, displayName: input.displayName.trim() },
        });
        return created;
      });
      await this.audit(actorId, 'staff.create', 'user', staff.id, {
        email,
        staffRoleId: input.staffRoleId ?? null,
      });
      return {
        id: staff.id,
        email: staff.email,
        status: staff.status,
        createdAt: staff.createdAt,
        staffRoleId: staff.staffRoleId,
      };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        throw new AppError(
          ErrorCodes.CONFLICT,
          'An account with this email already exists',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  listStaffRoles() {
    return this.prisma.staffRole.findMany({
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
  }

  async createStaffRole(
    actorId: string,
    input: { name: string; permissions: Permission[] },
  ) {
    for (const permission of input.permissions) {
      assertKnownPermission(permission);
    }
    const name = input.name.trim();
    if (name.length < 2) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Role name must be at least 2 characters',
      );
    }
    const existing = await this.prisma.staffRole.findUnique({
      where: { name },
    });
    if (existing) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        'A role with this name already exists',
        HttpStatus.CONFLICT,
      );
    }
    const role = await this.prisma.staffRole.create({
      data: { name, permissions: input.permissions },
    });
    await this.audit(actorId, 'staff_role.create', 'staff_role', role.id, {
      name,
      permissions: input.permissions,
    });
    return role;
  }

  async updateStaffRole(
    actorId: string,
    roleId: string,
    input: { name?: string; permissions?: Permission[] },
  ) {
    if (input.permissions) {
      for (const permission of input.permissions) {
        assertKnownPermission(permission);
      }
    }
    const role = await this.prisma.staffRole.findUnique({
      where: { id: roleId },
    });
    if (!role) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Role not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const updated = await this.prisma.staffRole.update({
      where: { id: roleId },
      data: {
        ...(input.name ? { name: input.name.trim() } : {}),
        ...(input.permissions ? { permissions: input.permissions } : {}),
      },
    });
    await this.audit(actorId, 'staff_role.update', 'staff_role', roleId, {
      ...input,
    });
    return updated;
  }

  async deleteStaffRole(actorId: string, roleId: string) {
    const role = await this.prisma.staffRole.findUnique({
      where: { id: roleId },
    });
    if (!role) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Role not found',
        HttpStatus.NOT_FOUND,
      );
    }
    // Members fall back to unrestricted ADMIN access (staffRoleId -> null
    // via the schema's onDelete: SetNull) rather than being locked out.
    await this.prisma.staffRole.delete({ where: { id: roleId } });
    await this.audit(actorId, 'staff_role.delete', 'staff_role', roleId, {
      name: role.name,
    });
    return { ok: true };
  }

  async setUserStaffRole(
    actorId: string,
    userId: string,
    staffRoleId: string | null,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (user.role !== 'ADMIN') {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'A staff role can only be assigned to an ADMIN account',
      );
    }
    if (staffRoleId) {
      const role = await this.prisma.staffRole.findUnique({
        where: { id: staffRoleId },
      });
      if (!role) {
        throw new AppError(
          ErrorCodes.NOT_FOUND,
          'Role not found',
          HttpStatus.NOT_FOUND,
        );
      }
    }
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { staffRoleId },
      select: { id: true, email: true, staffRoleId: true },
    });
    await this.audit(actorId, 'user.staff_role.set', 'user', userId, {
      staffRoleId,
    });
    return updated;
  }

  // --- Host supervision ---------------------------------------------------

  getHostSupervisor(hostUserId: string) {
    return this.prisma.hostSupervision.findUnique({
      where: { hostUserId },
      include: { staff: { select: { id: true, email: true } } },
    });
  }

  async assignHostSupervisor(
    actorId: string,
    hostUserId: string,
    staffUserId: string,
  ) {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId: hostUserId },
    });
    if (!host) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Host not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const staff = await this.prisma.user.findUnique({
      where: { id: staffUserId },
    });
    if (!staff || staff.role !== 'ADMIN') {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Supervisor must be an ADMIN (staff) account',
      );
    }
    const supervision = await this.prisma.hostSupervision.upsert({
      where: { hostUserId },
      create: { hostUserId, staffUserId },
      update: { staffUserId, assignedAt: new Date() },
    });
    await this.audit(
      actorId,
      'host.supervisor.assign',
      'host',
      hostUserId,
      { staffUserId },
    );
    return supervision;
  }

  async removeHostSupervisor(actorId: string, hostUserId: string) {
    const existing = await this.prisma.hostSupervision.findUnique({
      where: { hostUserId },
    });
    if (!existing) {
      return { ok: true };
    }
    await this.prisma.hostSupervision.delete({ where: { hostUserId } });
    await this.audit(actorId, 'host.supervisor.remove', 'host', hostUserId, {
      previousStaffUserId: existing.staffUserId,
    });
    return { ok: true };
  }
}
