import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import {
  HostAvailability,
  HostStatus,
  HostVerificationStatus,
  Prisma,
} from '@prisma/client';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeEmitter } from '../../realtime/realtime-emitter';
import { NotificationsService } from '../notifications/notifications.service';
import {
  HOST_AGREEMENT_VERSIONS,
  REQUIRED_HOST_AGREEMENTS,
} from './host-agreements';
import { HostCompletenessService } from './host-completeness.service';

export type HostAgreementAcceptanceInput = {
  agreementType: string;
  version: string;
};

export type HostApplyInput = {
  applicationBio: string;
  languages: string[];
  interests: string[];
  voiceEnabled?: boolean;
  videoEnabled?: boolean;
  voiceRatePerMinuteCents?: number;
  videoRatePerMinuteCents?: number;
  acceptedAgreements: HostAgreementAcceptanceInput[];
};

export type HostPatchInput = {
  voiceEnabled?: boolean;
  videoEnabled?: boolean;
  voiceRatePerMinuteCents?: number;
  videoRatePerMinuteCents?: number;
  languages?: string[];
  interests?: string[];
  applicationBio?: string;
};

const MAX_RATE = 100_000;
const MAX_LIST = 12;

@Injectable()
export class HostsService {
  private readonly logger = new Logger(HostsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeEmitter,
    private readonly notifications: NotificationsService,
    private readonly completeness: HostCompletenessService,
  ) {}

  async getMe(userId: string) {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
    });
    if (!host) {
      return { hostStatus: 'NOT_HOST' as const, host: null };
    }
    const completeness = await this.completeness.evaluate(userId);
    return {
      hostStatus: host.status,
      host: this.privateHost(host),
      completeness,
    };
  }

  async getCompleteness(userId: string) {
    await this.requireHost(userId);
    return this.completeness.evaluate(userId);
  }

  async dashboard(userId: string) {
    const host = await this.requireHost(userId);
    const completeness = await this.completeness.evaluate(userId);
    const startOfToday = this.startOfUtcDay(new Date());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setUTCDate(startOfWeek.getUTCDate() - 7);
    const startOfMonth = new Date(
      Date.UTC(startOfToday.getUTCFullYear(), startOfToday.getUTCMonth(), 1),
    );
    const wallet = await this.prisma.wallet.findUnique({
      where: { userId },
    });
    if (!wallet) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Wallet not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const [
      todayCalls,
      todayMinutes,
      unread,
      recentCalls,
      earnedToday,
      earnedWeek,
      earnedMonth,
      earnedLife,
      paidOut,
      pending,
    ] = await Promise.all([
      this.prisma.call.count({
        where: {
          calleeId: userId,
          status: 'ENDED',
          endedAt: { gte: startOfToday },
        },
      }),
      this.prisma.call.aggregate({
        where: {
          calleeId: userId,
          status: 'ENDED',
          endedAt: { gte: startOfToday },
        },
        _sum: { billedSeconds: true },
      }),
      this.prisma.message.count({
        where: {
          readAt: null,
          senderId: { not: userId },
          conversation: {
            OR: [{ participantAId: userId }, { participantBId: userId }],
          },
        },
      }),
      this.prisma.call.findMany({
        where: { calleeId: userId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      }),
      this.sumEarnings(wallet.id, startOfToday),
      this.sumEarnings(wallet.id, startOfWeek),
      this.sumEarnings(wallet.id, startOfMonth),
      this.sumEarnings(wallet.id),
      this.prisma.walletLedgerEntry.aggregate({
        where: { walletId: wallet.id, reason: 'PAYOUT' },
        _sum: { amountCents: true },
      }),
      this.prisma.payoutRequest.aggregate({
        where: { userId, status: { in: ['REQUESTED', 'PROCESSING'] } },
        _sum: { amountCents: true },
      }),
    ]);
    return {
      host: this.privateHost(host),
      completeness,
      stats: {
        todayCallCount: todayCalls,
        todayBilledSeconds: todayMinutes._sum.billedSeconds ?? 0,
        unreadMessageCount: unread,
        todayEarnedCents: earnedToday,
        weekEarnedCents: earnedWeek,
        monthEarnedCents: earnedMonth,
        lifetimeEarnedCents: earnedLife,
        lifetimePaidOutCents: paidOut._sum.amountCents ?? 0,
        pendingPayoutCents: pending._sum.amountCents ?? 0,
        availableBalanceCents: wallet.availableBalanceCents,
      },
      recentCalls: recentCalls.map((call) => ({
        id: call.id,
        callType: call.callType,
        status: call.status,
        billedSeconds: call.billedSeconds,
        billedAmountCents: call.billedAmountCents,
        createdAt: call.createdAt,
      })),
    };
  }

  async apply(userId: string, input: HostApplyInput) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { profile: true, hostProfile: true },
    });
    if (!user || user.status !== 'ACTIVE' || !user.profile) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (user.hostProfile?.status === 'SUSPENDED') {
      throw new AppError(
        ErrorCodes.HOST_SUSPENDED,
        'This host account is suspended',
        HttpStatus.FORBIDDEN,
      );
    }
    if (user.hostProfile?.status === 'ACTIVE') {
      throw new AppError(
        ErrorCodes.HOST_APPLICATION_EXISTS,
        'Already an active host',
        HttpStatus.CONFLICT,
      );
    }
    if (user.hostProfile?.status === 'PENDING_REVIEW') {
      throw new AppError(
        ErrorCodes.HOST_APPLICATION_EXISTS,
        'Host application is already pending',
        HttpStatus.CONFLICT,
      );
    }

    this.assertRequiredAgreements(input.acceptedAgreements);

    const languages = this.normalizeList(input.languages);
    const interests = this.normalizeList(input.interests);
    const bio = input.applicationBio.trim();
    if (bio.length < 8 || languages.length === 0) {
      throw new AppError(
        ErrorCodes.HOST_APPLICATION_INVALID,
        'Host application is incomplete',
      );
    }
    const voiceEnabled = input.voiceEnabled !== false;
    const videoEnabled = input.videoEnabled !== false;
    if (!voiceEnabled && !videoEnabled) {
      throw new AppError(
        ErrorCodes.HOST_APPLICATION_INVALID,
        'Enable at least one call type',
      );
    }
    const voiceRate = this.clampRate(
      input.voiceRatePerMinuteCents ?? user.profile.ratePerMinuteCents,
    );
    const videoRate = this.clampRate(
      input.videoRatePerMinuteCents ?? voiceRate + 50,
    );

    const host = await this.prisma.$transaction(async (tx) => {
      const next = await tx.hostProfile.upsert({
        where: { userId },
        update: {
          status: 'PENDING_REVIEW',
          availability: 'OFFLINE',
          applicationBio: bio.slice(0, 500),
          languages,
          interests,
          voiceEnabled,
          videoEnabled,
          voiceRatePerMinuteCents: voiceRate,
          videoRatePerMinuteCents: videoRate,
          submittedAt: new Date(),
          reviewNote: null,
          internalNote: null,
          reviewedAt: null,
          reviewedById: null,
          // Self-attestation only — external KYC remains CONFIG_REQUIRED.
          verificationStatus: 'NOT_REQUIRED',
        },
        create: {
          userId,
          applicationBio: bio.slice(0, 500),
          languages,
          interests,
          voiceEnabled,
          videoEnabled,
          voiceRatePerMinuteCents: voiceRate,
          videoRatePerMinuteCents: videoRate,
          verificationStatus: 'NOT_REQUIRED',
        },
      });
      await tx.profile.update({
        where: { userId },
        data: {
          isDiscoverable: false,
          ratePerMinuteCents: voiceRate,
          bio: bio.slice(0, 280),
        },
      });
      for (const item of REQUIRED_HOST_AGREEMENTS) {
        await tx.hostAgreementAcceptance.upsert({
          where: {
            userId_agreementType_version: {
              userId,
              agreementType: item.agreementType,
              version: item.version,
            },
          },
          create: {
            userId,
            agreementType: item.agreementType,
            version: item.version,
          },
          update: { acceptedAt: new Date() },
        });
      }
      return next;
    });

    await this.notifications.notifyUser(userId, {
      type: 'host_application',
      title: 'Host application submitted',
      body: 'We will review your host profile shortly.',
    });
    this.logger.log({ userId }, 'host.application_submitted');
    return this.privateHost(host);
  }

  async patchMe(userId: string, patch: HostPatchInput) {
    const host = await this.requireHost(userId);
    if (host.status !== 'ACTIVE' && host.status !== 'PENDING_REVIEW') {
      throw new AppError(
        ErrorCodes.FORBIDDEN,
        'Host profile cannot be edited',
        HttpStatus.FORBIDDEN,
      );
    }
    const data: Prisma.HostProfileUpdateInput = {};
    if (patch.voiceEnabled !== undefined) {
      data.voiceEnabled = patch.voiceEnabled;
    }
    if (patch.videoEnabled !== undefined) {
      data.videoEnabled = patch.videoEnabled;
    }
    if (patch.voiceRatePerMinuteCents !== undefined) {
      data.voiceRatePerMinuteCents = this.clampRate(
        patch.voiceRatePerMinuteCents,
      );
    }
    if (patch.videoRatePerMinuteCents !== undefined) {
      data.videoRatePerMinuteCents = this.clampRate(
        patch.videoRatePerMinuteCents,
      );
    }
    if (patch.languages) {
      data.languages = this.normalizeList(patch.languages);
    }
    if (patch.interests) {
      data.interests = this.normalizeList(patch.interests);
    }
    if (patch.applicationBio !== undefined) {
      data.applicationBio = patch.applicationBio.trim().slice(0, 500);
    }

    const nextVoice =
      patch.voiceEnabled !== undefined ? patch.voiceEnabled : host.voiceEnabled;
    const nextVideo =
      patch.videoEnabled !== undefined ? patch.videoEnabled : host.videoEnabled;
    if (!nextVoice && !nextVideo) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Enable at least one call type',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.hostProfile.update({
        where: { userId },
        data,
      });
      await tx.profile.update({
        where: { userId },
        data: { ratePerMinuteCents: next.voiceRatePerMinuteCents },
      });
      return next;
    });

    // ACTIVE hosts that become incomplete are forced offline / undiscoverable.
    if (updated.status === 'ACTIVE') {
      await this.reconcileDiscoverability(userId);
    }
    return this.privateHost(updated);
  }

  async setAvailability(userId: string, availability: HostAvailability) {
    if (availability === 'BUSY') {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Busy is reserved for active calls',
      );
    }
    const host = await this.requireHost(userId);
    if (host.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCodes.HOST_NOT_ACTIVE,
        'Host is not approved',
        HttpStatus.FORBIDDEN,
      );
    }
    if (host.availability === 'BUSY') {
      throw new AppError(
        ErrorCodes.HOST_BUSY,
        'Finish the active call before changing availability',
        HttpStatus.CONFLICT,
      );
    }
    if (availability === 'ONLINE') {
      const completeness = await this.completeness.evaluate(userId);
      if (!completeness.isComplete) {
        throw new AppError(
          ErrorCodes.HOST_INCOMPLETE,
          'Host profile is incomplete.',
          HttpStatus.CONFLICT,
          { missingFields: completeness.missingFields },
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.hostProfile.update({
        where: { userId },
        data: { availability },
      });
      // Only ONLINE hosts are discoverable. PAUSED/OFFLINE are hidden.
      await tx.profile.update({
        where: { userId },
        data: {
          isDiscoverable: availability === 'ONLINE',
          ...(availability === 'ONLINE' ? { lastActiveAt: new Date() } : {}),
        },
      });
      return next;
    });
    this.emitAvailability(updated);
    return this.publicHost(updated);
  }

  async markBusy(userId: string): Promise<void> {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
    });
    if (!host || host.status !== 'ACTIVE') {
      return;
    }
    if (host.availability === 'ONLINE' || host.availability === 'BUSY') {
      const updated = await this.prisma.hostProfile.update({
        where: { userId },
        data: { availability: 'BUSY' },
      });
      await this.prisma.profile.update({
        where: { userId },
        data: { isDiscoverable: false },
      });
      this.emitAvailability(updated);
    }
  }

  async clearBusy(userId: string): Promise<void> {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
    });
    if (!host || host.availability !== 'BUSY') {
      return;
    }
    // After a call, return to ONLINE when still ACTIVE and complete.
    const completeness = await this.completeness.evaluate(userId);
    const nextAvailability: HostAvailability =
      host.status === 'ACTIVE' && completeness.isComplete
        ? 'ONLINE'
        : 'OFFLINE';
    const updated = await this.prisma.hostProfile.update({
      where: { userId },
      data: { availability: nextAvailability },
    });
    await this.prisma.profile.update({
      where: { userId },
      data: {
        isDiscoverable: nextAvailability === 'ONLINE',
        ...(nextAvailability === 'ONLINE' ? { lastActiveAt: new Date() } : {}),
      },
    });
    this.emitAvailability(updated);
  }

  async assertCallable(calleeId: string, callType: 'VOICE' | 'VIDEO') {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId: calleeId },
    });
    if (!host || host.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCodes.HOST_NOT_ACTIVE,
        'This host is currently unavailable.',
        HttpStatus.FORBIDDEN,
      );
    }
    if (host.availability === 'BUSY') {
      throw new AppError(
        ErrorCodes.HOST_BUSY,
        'This host is currently on another call.',
        HttpStatus.CONFLICT,
      );
    }
    if (host.availability !== 'ONLINE') {
      throw new AppError(
        ErrorCodes.HOST_UNAVAILABLE,
        'This host is currently unavailable.',
        HttpStatus.CONFLICT,
      );
    }
    if (callType === 'VOICE' && !host.voiceEnabled) {
      throw new AppError(
        ErrorCodes.HOST_CALL_TYPE_DISABLED,
        'Voice calls are not enabled for this host.',
        HttpStatus.CONFLICT,
      );
    }
    if (callType === 'VIDEO' && !host.videoEnabled) {
      throw new AppError(
        ErrorCodes.HOST_CALL_TYPE_DISABLED,
        'Video calls are not enabled for this host.',
        HttpStatus.CONFLICT,
      );
    }
    return host;
  }

  async requireActiveHost(userId: string) {
    const host = await this.requireHost(userId);
    if (host.status !== 'ACTIVE') {
      throw new AppError(
        ErrorCodes.HOST_NOT_ACTIVE,
        'Host is not approved',
        HttpStatus.FORBIDDEN,
      );
    }
    return host;
  }

  listForAdmin(status?: HostStatus) {
    return this.prisma.hostProfile.findMany({
      where: status ? { status } : {},
      orderBy: { submittedAt: 'desc' },
      take: 100,
      include: {
        user: {
          select: {
            id: true,
            email: true,
            status: true,
            profile: {
              select: {
                displayName: true,
                avatarUrl: true,
                bio: true,
              },
            },
          },
        },
        agreementAcceptances: {
          select: {
            agreementType: true,
            version: true,
            acceptedAt: true,
          },
        },
      },
    });
  }

  async adminGetHost(userId: string) {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            status: true,
            profile: true,
          },
        },
        agreementAcceptances: true,
      },
    });
    if (!host) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Host not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const completeness = await this.completeness.evaluate(userId);
    return {
      ...host,
      completeness,
    };
  }

  async adminSetStatus(
    actorId: string,
    userId: string,
    status: HostStatus,
    reviewNote?: string,
    internalNote?: string,
  ) {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
    });
    if (!host) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Host not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const allowed = this.adminTransition(host.status, status);
    if (!allowed) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        `Cannot move host from ${host.status} to ${status}`,
        HttpStatus.CONFLICT,
      );
    }

    if (status === 'ACTIVE' && host.status !== 'ACTIVE') {
      const completeness = await this.completeness.evaluate(userId);
      if (!completeness.isComplete) {
        throw new AppError(
          ErrorCodes.HOST_INCOMPLETE,
          'Host profile is incomplete.',
          HttpStatus.CONFLICT,
          { missingFields: completeness.missingFields },
        );
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.hostProfile.update({
        where: { userId },
        data: {
          status,
          availability: status === 'ACTIVE' ? host.availability : 'OFFLINE',
          reviewNote:
            reviewNote !== undefined
              ? reviewNote.slice(0, 500)
              : host.reviewNote,
          internalNote:
            internalNote !== undefined
              ? internalNote.slice(0, 1000)
              : host.internalNote,
          reviewedAt: new Date(),
          reviewedById: actorId,
        },
      });
      await tx.profile.update({
        where: { userId },
        data: {
          isDiscoverable: status === 'ACTIVE' && next.availability === 'ONLINE',
        },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: `host.${status.toLowerCase()}`,
          targetType: 'host',
          targetId: userId,
          metadata: {
            from: host.status,
            to: status,
            hasInternalNote: Boolean(internalNote),
          },
        },
      });
      return next;
    });
    const title =
      status === 'ACTIVE'
        ? 'You are now a Gmatez host'
        : status === 'REJECTED'
          ? 'Host application update'
          : 'Host account update';
    await this.notifications.notifyUser(userId, {
      type: 'host_status',
      title,
      body:
        status === 'ACTIVE'
          ? 'Your host application was approved. Go online to receive calls.'
          : status === 'REJECTED'
            ? (updated.reviewNote ?? 'Your host application was not approved.')
            : `Host status is now ${status}.`,
    });
    this.emitAvailability(updated);
    this.logger.log(
      { userId, from: host.status, to: status, actorId },
      'host.status_changed',
    );
    return this.privateHost(updated);
  }

  async adminSetVerification(
    actorId: string,
    userId: string,
    verificationStatus: HostVerificationStatus,
    internalNote?: string,
  ) {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
    });
    if (!host) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Host not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.hostProfile.update({
        where: { userId },
        data: {
          verificationStatus,
          ...(internalNote !== undefined
            ? { internalNote: internalNote.slice(0, 1000) }
            : {}),
          reviewedAt: new Date(),
          reviewedById: actorId,
        },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          action: `host.verification.${verificationStatus.toLowerCase()}`,
          targetType: 'host',
          targetId: userId,
          metadata: { from: host.verificationStatus, to: verificationStatus },
        },
      });
      return next;
    });
    if (updated.status === 'ACTIVE') {
      await this.reconcileDiscoverability(userId);
    }
    return this.privateHost(updated);
  }

  publicHost(host: {
    userId: string;
    status: HostStatus;
    availability: HostAvailability;
    voiceEnabled: boolean;
    videoEnabled: boolean;
    voiceRatePerMinuteCents: number;
    videoRatePerMinuteCents: number;
    languages: string[];
    interests: string[];
  }) {
    return {
      userId: host.userId,
      status: host.status,
      availability: host.availability,
      voiceEnabled: host.voiceEnabled,
      videoEnabled: host.videoEnabled,
      voiceRatePerMinuteCents: host.voiceRatePerMinuteCents,
      videoRatePerMinuteCents: host.videoRatePerMinuteCents,
      languages: host.languages,
      interests: host.interests,
      availableForCall:
        host.status === 'ACTIVE' && host.availability === 'ONLINE',
    };
  }

  private privateHost(host: {
    userId: string;
    status: HostStatus;
    availability: HostAvailability;
    verificationStatus: HostVerificationStatus;
    voiceEnabled: boolean;
    videoEnabled: boolean;
    voiceRatePerMinuteCents: number;
    videoRatePerMinuteCents: number;
    languages: string[];
    interests: string[];
    applicationBio: string;
    reviewNote: string | null;
    submittedAt: Date;
    reviewedAt: Date | null;
  }) {
    return {
      ...this.publicHost(host),
      verificationStatus: host.verificationStatus,
      applicationBio: host.applicationBio,
      reviewNote: host.reviewNote,
      submittedAt: host.submittedAt,
      reviewedAt: host.reviewedAt,
    };
  }

  private async requireHost(userId: string) {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
    });
    if (!host) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Host profile not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return host;
  }

  private async reconcileDiscoverability(userId: string) {
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
    });
    if (!host || host.status !== 'ACTIVE') {
      return;
    }
    const completeness = await this.completeness.evaluate(userId);
    if (!completeness.isComplete || host.availability !== 'ONLINE') {
      await this.prisma.$transaction([
        this.prisma.hostProfile.update({
          where: { userId },
          data: {
            availability: host.availability === 'BUSY' ? 'BUSY' : 'OFFLINE',
          },
        }),
        this.prisma.profile.update({
          where: { userId },
          data: { isDiscoverable: false },
        }),
      ]);
      if (host.availability !== 'BUSY' && host.availability !== 'OFFLINE') {
        this.emitAvailability({
          userId,
          status: host.status,
          availability: 'OFFLINE',
        });
      }
    }
  }

  private emitAvailability(host: {
    userId: string;
    status: HostStatus;
    availability: HostAvailability;
  }) {
    this.realtime.emitToUser(host.userId, 'host.availability.updated', {
      userId: host.userId,
      status: host.status,
      availability: host.availability,
    });
  }

  private adminTransition(from: HostStatus, to: HostStatus) {
    if (from === to) {
      return true;
    }
    const map: Record<HostStatus, HostStatus[]> = {
      PENDING_REVIEW: ['ACTIVE', 'REJECTED'],
      ACTIVE: ['SUSPENDED'],
      SUSPENDED: ['ACTIVE'],
      // Rejected hosts re-apply into PENDING_REVIEW; admins do not jump to ACTIVE.
      REJECTED: ['PENDING_REVIEW'],
    };
    return map[from].includes(to);
  }

  private assertRequiredAgreements(
    accepted: HostAgreementAcceptanceInput[] | undefined,
  ) {
    if (!accepted || accepted.length === 0) {
      throw new AppError(
        ErrorCodes.HOST_AGREEMENT_REQUIRED,
        'Mandatory host agreements must be accepted',
        HttpStatus.BAD_REQUEST,
      );
    }
    const provided = new Map(
      accepted.map((item) => [
        item.agreementType.trim().toUpperCase(),
        item.version.trim(),
      ]),
    );
    for (const required of REQUIRED_HOST_AGREEMENTS) {
      const version = provided.get(required.agreementType);
      if (version !== required.version) {
        throw new AppError(
          ErrorCodes.HOST_AGREEMENT_REQUIRED,
          `Agreement ${required.agreementType} version ${required.version} is required`,
          HttpStatus.BAD_REQUEST,
          {
            agreementType: required.agreementType,
            version: required.version,
          },
        );
      }
    }
    // Reject unknown types / versions silently by only persisting REQUIRED set.
    for (const [type] of provided) {
      if (!(type in HOST_AGREEMENT_VERSIONS)) {
        throw new AppError(
          ErrorCodes.HOST_AGREEMENT_REQUIRED,
          `Unknown agreement type: ${type}`,
        );
      }
    }
  }

  private normalizeList(values: string[]) {
    const unique = [
      ...new Set(
        values
          .map((value) => value.trim().toLowerCase())
          .filter((value) => /^[a-z0-9-]{2,24}$/.test(value)),
      ),
    ];
    return unique.slice(0, MAX_LIST);
  }

  private clampRate(rate: number) {
    if (!Number.isInteger(rate) || rate < 1 || rate > MAX_RATE) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Rate per minute is invalid',
      );
    }
    return rate;
  }

  private startOfUtcDay(date: Date) {
    return new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
    );
  }

  private async sumEarnings(walletId: string, since?: Date) {
    const result = await this.prisma.walletLedgerEntry.aggregate({
      where: {
        walletId,
        reason: 'CREATOR_EARNING',
        ...(since ? { createdAt: { gte: since } } : {}),
      },
      _sum: { amountCents: true },
    });
    return result._sum.amountCents ?? 0;
  }
}
