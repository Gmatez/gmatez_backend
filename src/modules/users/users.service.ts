import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { toPublicProfile } from '../profiles/profile.presenter';

@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
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
    await this.prisma.profile.update({
      where: { userId },
      data: { lastActiveAt: new Date() },
    });
  }

  async deleteMe(userId: string): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
      this.prisma.deviceToken.deleteMany({ where: { userId } }),
      this.prisma.hostProfile.updateMany({
        where: { userId },
        data: { status: 'SUSPENDED', availability: 'OFFLINE' },
      }),
      this.prisma.profile.update({
        where: { userId },
        data: {
          displayName: 'Deleted user',
          bio: '',
          avatarUrl: null,
          isDiscoverable: false,
        },
      }),
      this.prisma.user.update({
        where: { id: userId },
        data: {
          status: 'DELETED',
          email: `deleted+${userId}@invalid.local`,
        },
      }),
    ]);
  }
}
