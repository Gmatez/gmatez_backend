import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Gender } from '@prisma/client';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { toOwnProfile } from './profile.presenter';

export type ProfilePatch = {
  displayName?: string;
  bio?: string;
  gender?: Gender;
  country?: string | null;
  language?: string | null;
  avatarUrl?: string | null;
  isDiscoverable?: boolean;
  ratePerMinuteCents?: number;
};

const HTTP_URL = /^https?:\/\/[^\s]+$/i;

@Injectable()
export class ProfilesService {
  private readonly logger = new Logger(ProfilesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async getMine(userId: string) {
    const profile = await this.prisma.profile.findUnique({ where: { userId } });
    if (!profile) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Profile not found',
        HttpStatus.NOT_FOUND,
      );
    }
    const online = (await this.redis.onlineUserIds([userId])).has(userId);
    return toOwnProfile(profile, online);
  }

  async updateMine(userId: string, patch: ProfilePatch) {
    const data = this.normalizePatch(patch);
    const profile = await this.prisma.profile.update({
      where: { userId },
      data,
    });
    this.logger.log({ userId }, 'profile updated');
    const online = (await this.redis.onlineUserIds([userId])).has(userId);
    return toOwnProfile(profile, online);
  }

  private normalizePatch(patch: ProfilePatch): ProfilePatch {
    const data: ProfilePatch = { ...patch };
    if (data.displayName !== undefined) {
      data.displayName = data.displayName.trim();
      if (data.displayName.length < 2 || data.displayName.length > 40) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          'Display name must be 2-40 characters',
        );
      }
    }
    if (data.bio !== undefined && data.bio.length > 280) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Bio must be 280 characters or fewer',
      );
    }
    if (data.country !== undefined && data.country !== null) {
      const country = data.country.trim().toUpperCase();
      if (country !== '' && !/^[A-Z]{2}$/.test(country)) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          'Country must be a 2-letter code',
        );
      }
      data.country = country === '' ? null : country;
    }
    if (data.language !== undefined && data.language !== null) {
      const language = data.language.trim().toLowerCase();
      if (language !== '' && !/^[a-z-]{2,16}$/.test(language)) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          'Language is invalid',
        );
      }
      data.language = language === '' ? null : language;
    }
    if (data.avatarUrl !== undefined) {
      const url = data.avatarUrl?.trim() ?? '';
      if (url === '') {
        data.avatarUrl = null;
      } else if (!HTTP_URL.test(url) || url.length > 2048) {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          'Avatar URL must be an http(s) URL',
        );
      } else {
        data.avatarUrl = url;
      }
    }
    if (
      data.ratePerMinuteCents !== undefined &&
      (data.ratePerMinuteCents < 0 || data.ratePerMinuteCents > 100000)
    ) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Rate cannot be negative',
      );
    }
    return data;
  }
}
