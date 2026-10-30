import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { CallingService } from '../calling/calling.service';
import { HostDocumentsService } from '../hosts/host-documents.service';
import { toPublicProfile } from '../profiles/profile.presenter';
import { nextLastActiveAt } from './activity';

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly calling: CallingService,
    private readonly hostDocuments: HostDocumentsService,
  ) {}

  async getMe(userId: string) {
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
      },
    });
    if (!user) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      ...user,
      host: user.hostProfile
        ? {
            status: user.hostProfile.status,
            availability: user.hostProfile.availability,
            voiceEnabled: user.hostProfile.voiceEnabled,
            videoEnabled: user.hostProfile.videoEnabled,
            voiceRatePerMinuteCents: user.hostProfile.voiceRatePerMinuteCents,
            videoRatePerMinuteCents: user.hostProfile.videoRatePerMinuteCents,
            languages: user.hostProfile.languages,
            interests: user.hostProfile.interests,
            applicationBio: user.hostProfile.applicationBio,
            reviewNote: user.hostProfile.reviewNote,
          }
        : null,
    };
  }

  async getPublic(viewerId: string, userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        status: true,
        profile: {
          select: {
            displayName: true,
            bio: true,
            gender: true,
            country: true,
            language: true,
            avatarUrl: true,
            isDiscoverable: true,
            ratePerMinuteCents: true,
            lastActiveAt: true,
          },
        },
        hostProfile: {
          select: {
            status: true,
            availability: true,
            voiceEnabled: true,
            videoEnabled: true,
            voiceRatePerMinuteCents: true,
            videoRatePerMinuteCents: true,
            languages: true,
            interests: true,
          },
        },
      },
    });
    const isSelf = viewerId === userId;
    const host = user?.hostProfile ?? null;
    if (
      !user ||
      user.status !== 'ACTIVE' ||
      !user.profile ||
      (!isSelf && host?.status !== 'ACTIVE')
    ) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'User not found',
        HttpStatus.NOT_FOUND,
      );
    }
    if (!isSelf) {
      const blocked = await this.prisma.block.findFirst({
        where: {
          OR: [
            { blockerId: viewerId, blockedId: userId },
            { blockerId: userId, blockedId: viewerId },
          ],
        },
      });
      if (blocked) {
        throw new AppError(
          ErrorCodes.NOT_FOUND,
          'User not found',
          HttpStatus.NOT_FOUND,
        );
      }
    }
    const online = (await this.redis.onlineUserIds([userId])).has(userId);
    return toPublicProfile(user.id, user.profile, online, host);
  }

  async heartbeat(userId: string): Promise<void> {
    await this.redis.client.set(`presence:${userId}`, '1', 'EX', 60);
    const profile = await this.prisma.profile.findUnique({
      where: { userId },
      select: { lastActiveAt: true },
    });
    if (!profile) return;
    await this.prisma.profile.update({
      where: { userId },
      data: {
        lastActiveAt: nextLastActiveAt(
          profile.lastActiveAt,
          'heartbeat',
          new Date(),
        ),
      },
    });
  }

  /**
   * Self-service "right to erasure" deletion. Hard-deleting the User row
   * is not possible once a user has any history: Payment, Call, Report,
   * Conversation, and PayoutRequest all use onDelete: Restrict, by design
   * (financial/dispute records must survive). This anonymizes every PII
   * field in place instead, deletes purely personal rows that don't carry
   * compliance weight (sessions, push tokens, on-disk ID documents), and
   * leaves the restricted rows' foreign keys intact with their own PII
   * (PayoutDestination.detailsJson) scrubbed separately.
   */
  async deleteMe(userId: string): Promise<void> {
    const activeCall = await this.calling.findActiveCallForUser(userId);
    if (activeCall) {
      throw new AppError(
        ErrorCodes.CONFLICT,
        'End your active call before deleting your account',
        HttpStatus.CONFLICT,
      );
    }

    // argon2.verify() is called unconditionally on every login attempt
    // before the account-status check, so this must stay a structurally
    // valid hash (of a value nobody can know) rather than garbage, or a
    // deleted account's login attempts would 500 instead of 401.
    const deadPasswordHash = await argon2.hash(randomUUID());

    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.deviceToken.deleteMany({ where: { userId } }),
      this.prisma.payoutDestination.updateMany({
        where: { userId },
        data: { label: '', detailsJson: {} },
      }),
      this.prisma.hostProfile.updateMany({
        where: { userId },
        data: {
          status: 'SUSPENDED',
          availability: 'OFFLINE',
          applicationBio: '',
          reviewNote: null,
          internalNote: null,
          languages: [],
          interests: [],
          idProofType: null,
          idProofLast4: null,
          idProofMime: null,
          identityCardNumber: null,
          identityFrontMime: null,
          identityBackMime: null,
          profileImageMime: null,
        },
      }),
      this.prisma.profile.update({
        where: { userId },
        data: {
          displayName: 'Deleted user',
          bio: '',
          avatarUrl: null,
          country: null,
          language: null,
          isDiscoverable: false,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          status: 'DELETED',
          email: `deleted+${userId}@invalid.local`,
          phone: null,
          passwordHash: deadPasswordHash,
        },
      }),
      this.prisma.auditLog.create({
        data: {
          actorId: userId,
          action: 'user.self_delete',
          targetType: 'user',
          targetId: userId,
          metadata: { reason: 'self_service_erasure' },
        },
      }),
    ]);

    try {
      await this.hostDocuments.deleteAll(userId);
    } catch (error) {
      this.logger.error(
        {
          userId,
          err: error instanceof Error ? error.message : 'unknown',
        },
        'user.delete_documents_failed',
      );
    }
  }
}
