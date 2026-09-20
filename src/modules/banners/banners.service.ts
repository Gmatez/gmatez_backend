import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { PrismaService } from '../../database/prisma.service';

const AUDIENCES = new Set(['ALL', 'USER', 'HOST']);

export type BannerInput = {
  title: string;
  subtitle?: string;
  imageUrl?: string;
  ctaLabel?: string;
  deepLink?: string;
  audience?: string;
  priority?: number;
  isActive?: boolean;
  startsAt?: string;
  endsAt?: string;
};

@Injectable()
export class BannersService {
  constructor(private readonly prisma: PrismaService) {}

  async listActiveForUser(userId: string) {
    const now = new Date();
    const host = await this.prisma.hostProfile.findUnique({
      where: { userId },
      select: { status: true },
    });
    const isHost = host?.status === 'ACTIVE';
    const audienceFilter = isHost
      ? { in: ['ALL', 'HOST'] }
      : { in: ['ALL', 'USER'] };

    const rows = await this.prisma.promoBanner.findMany({
      where: {
        isActive: true,
        audience: audienceFilter,
        AND: [
          { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
          { OR: [{ endsAt: null }, { endsAt: { gte: now } }] },
        ],
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 10,
    });
    return rows.map((b) => this.present(b));
  }

  listAll() {
    return this.prisma.promoBanner.findMany({
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
  }

  async create(actorId: string, input: BannerInput) {
    if (!input.title?.trim()) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'title is required',
      );
    }
    const data = this.normalize(input);
    const banner = await this.prisma.promoBanner.create({
      data: data as {
        title: string;
        subtitle?: string;
        imageUrl?: string | null;
        ctaLabel?: string;
        deepLink?: string | null;
        audience?: string;
        priority?: number;
        isActive?: boolean;
        startsAt?: Date | null;
        endsAt?: Date | null;
      },
    });
    await this.audit(actorId, 'banner.create', banner.id);
    return this.present(banner);
  }

  async update(actorId: string, id: string, input: BannerInput) {
    await this.require(id);
    const data = this.normalize(input, { partial: true });
    const banner = await this.prisma.promoBanner.update({
      where: { id },
      data,
    });
    await this.audit(actorId, 'banner.update', id);
    return this.present(banner);
  }

  async remove(actorId: string, id: string) {
    await this.require(id);
    await this.prisma.promoBanner.delete({ where: { id } });
    await this.audit(actorId, 'banner.delete', id);
    return { ok: true };
  }

  private async require(id: string) {
    const existing = await this.prisma.promoBanner.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Banner not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return existing;
  }

  private normalize(input: BannerInput, opts?: { partial?: boolean }) {
    const audience = (input.audience ?? 'ALL').trim().toUpperCase();
    if (input.audience && !AUDIENCES.has(audience)) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'audience must be ALL, USER, or HOST',
      );
    }
    if (input.deepLink && !input.deepLink.startsWith('/')) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'deepLink must be an in-app path starting with /',
      );
    }
    if (input.imageUrl) {
      try {
        // eslint-disable-next-line no-new
        new URL(input.imageUrl);
      } catch {
        throw new AppError(
          ErrorCodes.VALIDATION_FAILED,
          'imageUrl must be a valid URL',
        );
      }
    }
    const data: Record<string, unknown> = {};
    if (!opts?.partial || input.title !== undefined) {
      data.title = input.title.trim();
    }
    if (!opts?.partial || input.subtitle !== undefined) {
      data.subtitle = (input.subtitle ?? '').trim();
    }
    if (input.imageUrl !== undefined) {
      data.imageUrl = input.imageUrl?.trim() || null;
    }
    if (input.ctaLabel !== undefined) {
      data.ctaLabel = input.ctaLabel.trim() || 'Learn more';
    }
    if (input.deepLink !== undefined) {
      data.deepLink = input.deepLink?.trim() || null;
    }
    if (input.audience !== undefined) {
      data.audience = audience;
    }
    if (input.priority !== undefined) {
      data.priority = input.priority;
    }
    if (input.isActive !== undefined) {
      data.isActive = input.isActive;
    }
    if (input.startsAt !== undefined) {
      data.startsAt = input.startsAt ? new Date(input.startsAt) : null;
    }
    if (input.endsAt !== undefined) {
      data.endsAt = input.endsAt ? new Date(input.endsAt) : null;
    }
    return data;
  }

  private present(b: {
    id: string;
    title: string;
    subtitle: string;
    imageUrl: string | null;
    ctaLabel: string;
    deepLink: string | null;
    audience: string;
    priority: number;
    isActive: boolean;
    startsAt: Date | null;
    endsAt: Date | null;
  }) {
    return {
      id: b.id,
      title: b.title,
      subtitle: b.subtitle,
      imageUrl: b.imageUrl,
      ctaLabel: b.ctaLabel,
      deepLink: b.deepLink,
      audience: b.audience,
      priority: b.priority,
      isActive: b.isActive,
      startsAt: b.startsAt,
      endsAt: b.endsAt,
    };
  }

  private audit(actorId: string, action: string, targetId: string) {
    return this.prisma.auditLog.create({
      data: {
        actorId,
        action,
        targetType: 'promo_banner',
        targetId,
      },
    });
  }
}
