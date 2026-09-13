import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import {
  CursorPage,
  decodeCursor,
  encodeCursor,
} from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { BlockingService } from '../blocking/blocking.service';
import {
  discoveryProfileSelect,
  DiscoveryProfileRow,
  toDiscoveryItem,
} from '../profiles/profile.presenter';

export type DiscoveryQuery = {
  limit: number;
  cursor?: string;
  q?: string;
  language?: string;
  onlineOnly?: boolean;
  callType?: 'VOICE' | 'VIDEO';
};

type DiscoveryItem = ReturnType<typeof toDiscoveryItem>;

@Injectable()
export class DiscoveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocking: BlockingService,
    private readonly redis: RedisService,
  ) {}

  feed(viewerId: string, query: DiscoveryQuery) {
    return this.page(viewerId, query);
  }

  search(viewerId: string, query: DiscoveryQuery) {
    const q = query.q?.trim() ?? '';
    if (q.length < 2) {
      return { items: [], nextCursor: null } satisfies CursorPage<DiscoveryItem>;
    }
    return this.page(viewerId, { ...query, q });
  }

  private async page(
    viewerId: string,
    query: DiscoveryQuery,
  ): Promise<CursorPage<DiscoveryItem>> {
    const excluded = await this.blocking.blockedIdsFor(viewerId);
    const items: DiscoveryItem[] = [];
    let cursor = query.cursor;
    let nextCursor: string | null = null;

    for (let attempt = 0; attempt < 5 && items.length < query.limit; attempt += 1) {
      const { rows, hasMore } = await this.fetchPage({
        viewerId,
        excluded,
        limit: query.limit,
        cursor,
        q: query.q,
        language: query.language,
        onlineOnly: query.onlineOnly,
        callType: query.callType,
      });
      if (rows.length === 0) {
        nextCursor = null;
        break;
      }
      const presence = await this.redis.onlineUserIds(
        rows.map((row) => row.userId),
      );
      const mapped = rows.map((row) =>
        toDiscoveryItem(row, presence.has(row.userId)),
      );
      const accepted = query.onlineOnly
        ? mapped.filter((item) => item.availableForCall)
        : mapped;
      items.push(...accepted);
      const last = rows[rows.length - 1];
      nextCursor = hasMore
        ? encodeCursor(last.lastActiveAt, last.userId)
        : null;
      if (!hasMore) {
        break;
      }
      cursor = nextCursor ?? undefined;
    }

    const sliced = items.slice(0, query.limit);
    return {
      items: sliced,
      nextCursor: sliced.length < query.limit ? null : nextCursor,
    };
  }

  private async fetchPage(input: {
    viewerId: string;
    excluded: string[];
    limit: number;
    cursor?: string;
    q?: string;
    language?: string;
    onlineOnly?: boolean;
    callType?: 'VOICE' | 'VIDEO';
  }): Promise<{ rows: DiscoveryProfileRow[]; hasMore: boolean }> {
    const cursorFilter = this.parseCursor(input.cursor);
    const search = input.q?.trim();
    const language = input.language?.toLowerCase();
    const rows = await this.prisma.profile.findMany({
      where: {
        userId: { notIn: [input.viewerId, ...input.excluded] },
        user: {
          status: 'ACTIVE',
          hostProfile: {
            status: 'ACTIVE',
            ...(input.onlineOnly ? { availability: 'ONLINE' } : {}),
            ...(input.callType === 'VOICE' ? { voiceEnabled: true } : {}),
            ...(input.callType === 'VIDEO' ? { videoEnabled: true } : {}),
            ...(language ? { languages: { has: language } } : {}),
          },
        },
        ...(search
          ? {
              OR: [
                { displayName: { contains: search, mode: 'insensitive' } },
                { bio: { contains: search, mode: 'insensitive' } },
              ],
            }
          : {}),
        ...(cursorFilter
          ? {
              OR: [
                { lastActiveAt: { lt: cursorFilter.createdAt } },
                {
                  lastActiveAt: cursorFilter.createdAt,
                  userId: { lt: cursorFilter.id },
                },
              ],
            }
          : {}),
      } satisfies Prisma.ProfileWhereInput,
      orderBy: [{ lastActiveAt: 'desc' }, { userId: 'desc' }],
      take: input.limit + 1,
      select: discoveryProfileSelect,
    });
    const hasMore = rows.length > input.limit;
    return {
      rows: hasMore ? rows.slice(0, input.limit) : rows,
      hasMore,
    };
  }

  private parseCursor(cursor?: string) {
    if (!cursor) {
      return undefined;
    }
    try {
      const parsed = decodeCursor(cursor);
      if (!parsed.id || Number.isNaN(parsed.createdAt.getTime())) {
        throw new Error('invalid');
      }
      return parsed;
    } catch {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Invalid cursor',
        HttpStatus.BAD_REQUEST,
      );
    }
  }
}
