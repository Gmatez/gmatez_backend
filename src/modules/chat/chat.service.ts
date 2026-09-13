import { HttpStatus, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import {
  CursorPage,
  decodeCursor,
  encodeCursor,
} from '../../common/dto/pagination.dto';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeEmitter } from '../../realtime/realtime-emitter';
import { BlockingService } from '../blocking/blocking.service';

const MAX_BODY = 2000;

@Injectable()
export class ChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blocking: BlockingService,
    private readonly realtime: RealtimeEmitter,
  ) {}

  async openConversation(userId: string, peerId: string) {
    if (userId === peerId) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Cannot message yourself',
      );
    }
    if (await this.blocking.isBlockedEitherWay(userId, peerId)) {
      throw new AppError(
        ErrorCodes.USER_BLOCKED,
        'User is unavailable',
        HttpStatus.FORBIDDEN,
      );
    }
    const peer = await this.prisma.user.findUnique({
      where: { id: peerId },
      include: { profile: true },
    });
    if (!peer || peer.status !== 'ACTIVE') {
      throw new AppError(ErrorCodes.NOT_FOUND, 'User not found', HttpStatus.NOT_FOUND);
    }
    const [participantAId, participantBId] = [userId, peerId].sort();
    const conversation = await this.prisma.conversation.upsert({
      where: {
        participantAId_participantBId: { participantAId, participantBId },
      },
      update: {},
      create: { participantAId, participantBId },
    });
    return this.presentConversation(conversation, userId);
  }

  async listConversations(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<CursorPage<Awaited<ReturnType<ChatService['presentConversation']>>>> {
    const cursorFilter = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.conversation.findMany({
      where: {
        AND: [
          { OR: [{ participantAId: userId }, { participantBId: userId }] },
          cursorFilter
            ? {
                OR: [
                  { lastMessageAt: { lt: cursorFilter.createdAt } },
                  {
                    lastMessageAt: cursorFilter.createdAt,
                    id: { lt: cursorFilter.id },
                  },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ lastMessageAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items: await this.presentConversations(items, userId),
      nextCursor:
        hasMore && last ? encodeCursor(last.lastMessageAt, last.id) : null,
    };
  }

  async listMessages(
    userId: string,
    conversationId: string,
    limit: number,
    cursor?: string,
  ) {
    await this.requireParticipant(conversationId, userId);
    const cursorFilter = cursor ? decodeCursor(cursor) : undefined;
    const rows = await this.prisma.message.findMany({
      where: {
        conversationId,
        ...(cursorFilter
          ? {
              OR: [
                { createdAt: { lt: cursorFilter.createdAt } },
                {
                  createdAt: cursorFilter.createdAt,
                  id: { lt: cursorFilter.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map((row) => this.presentMessage(row)).reverse(),
      nextCursor:
        hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }

  async peerIdFor(userId: string, conversationId: string): Promise<string | null> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (
      !conversation ||
      (conversation.participantAId !== userId &&
        conversation.participantBId !== userId)
    ) {
      return null;
    }
    return conversation.participantAId === userId
      ? conversation.participantBId
      : conversation.participantAId;
  }

  async sendMessage(
    userId: string,
    conversationId: string,
    body: string,
    idempotencyKey: string,
  ) {
    const trimmed = body.trim();
    if (!trimmed || trimmed.length > MAX_BODY) {
      throw new AppError(
        ErrorCodes.VALIDATION_FAILED,
        'Message body is invalid',
      );
    }
    const conversation = await this.requireParticipant(conversationId, userId);
    const peerId =
      conversation.participantAId === userId
        ? conversation.participantBId
        : conversation.participantAId;
    if (await this.blocking.isBlockedEitherWay(userId, peerId)) {
      throw new AppError(
        ErrorCodes.USER_BLOCKED,
        'User is unavailable',
        HttpStatus.FORBIDDEN,
      );
    }

    const existing = await this.prisma.message.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      if (existing.senderId !== userId) {
        throw new AppError(
          ErrorCodes.CONFLICT,
          'Idempotency key already used',
          HttpStatus.CONFLICT,
        );
      }
      return this.presentMessage(existing);
    }

    try {
      const message = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            conversationId,
            senderId: userId,
            body: trimmed,
            idempotencyKey,
          },
        });
        await tx.conversation.update({
          where: { id: conversationId },
          data: {
            lastMessageAt: created.createdAt,
            lastMessagePreview: trimmed.slice(0, 140),
          },
        });
        return created;
      });
      const payload = this.presentMessage(message);
      this.realtime.emitToUser(userId, 'message.created', payload);
      this.realtime.emitToUser(peerId, 'message.created', payload);
      return payload;
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const dup = await this.prisma.message.findUnique({
          where: { idempotencyKey },
        });
        if (dup) {
          return this.presentMessage(dup);
        }
      }
      throw error;
    }
  }

  async markRead(userId: string, conversationId: string) {
    const conversation = await this.requireParticipant(conversationId, userId);
    await this.prisma.message.updateMany({
      where: {
        conversationId,
        senderId: { not: userId },
        readAt: null,
      },
      data: { readAt: new Date() },
    });
    const peerId =
      conversation.participantAId === userId
        ? conversation.participantBId
        : conversation.participantAId;
    this.realtime.emitToUser(peerId, 'message.read', {
      conversationId,
      readerId: userId,
    });
    return { ok: true };
  }

  private async requireParticipant(conversationId: string, userId: string) {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (
      !conversation ||
      (conversation.participantAId !== userId &&
        conversation.participantBId !== userId)
    ) {
      throw new AppError(
        ErrorCodes.NOT_FOUND,
        'Conversation not found',
        HttpStatus.NOT_FOUND,
      );
    }
    return conversation;
  }

  private async presentConversations(
    conversations: Array<{
      id: string;
      participantAId: string;
      participantBId: string;
      lastMessageAt: Date;
      lastMessagePreview: string;
    }>,
    userId: string,
  ) {
    if (conversations.length === 0) {
      return [];
    }
    const peerIds = conversations.map((conversation) =>
      conversation.participantAId === userId
        ? conversation.participantBId
        : conversation.participantAId,
    );
    const ids = conversations.map((conversation) => conversation.id);
    const [profiles, unreadRows] = await Promise.all([
      this.prisma.profile.findMany({
        where: { userId: { in: peerIds } },
        select: { userId: true, displayName: true, avatarUrl: true },
      }),
      this.prisma.message.groupBy({
        by: ['conversationId', 'senderId'],
        where: {
          conversationId: { in: ids },
          senderId: { not: userId },
          readAt: null,
        },
        _count: { _all: true },
      }),
    ]);
    const profileByUser = new Map(profiles.map((row) => [row.userId, row]));
    const unreadByConversation = new Map<string, number>();
    for (const row of unreadRows) {
      unreadByConversation.set(
        row.conversationId,
        (unreadByConversation.get(row.conversationId) ?? 0) + row._count._all,
      );
    }
    return conversations.map((conversation) => {
      const peerId =
        conversation.participantAId === userId
          ? conversation.participantBId
          : conversation.participantAId;
      const peer = profileByUser.get(peerId);
      return {
        id: conversation.id,
        peerUserId: peerId,
        peerDisplayName: peer?.displayName ?? 'User',
        peerAvatarUrl: peer?.avatarUrl ?? null,
        lastMessageAt: conversation.lastMessageAt,
        lastMessagePreview: conversation.lastMessagePreview,
        unreadCount: unreadByConversation.get(conversation.id) ?? 0,
      };
    });
  }

  private async presentConversation(
    conversation: {
      id: string;
      participantAId: string;
      participantBId: string;
      lastMessageAt: Date;
      lastMessagePreview: string;
    },
    userId: string,
  ) {
    const [item] = await this.presentConversations([conversation], userId);
    return item;
  }

  private presentMessage(message: {
    id: string;
    conversationId: string;
    senderId: string;
    body: string;
    readAt: Date | null;
    createdAt: Date;
  }) {
    return {
      id: message.id,
      conversationId: message.conversationId,
      senderId: message.senderId,
      body: message.body,
      readAt: message.readAt,
      createdAt: message.createdAt,
    };
  }
}
