import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { QueueService } from '../../queue/queue.service';
import { PUSH_PROVIDER } from '../../providers/messaging/push.tokens';
import type { PushProvider } from '../../providers/messaging/push-provider';
import { RealtimeEmitter } from '../../realtime/realtime-emitter';

@Injectable()
export class NotificationsService implements OnModuleInit {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queue: QueueService,
    @Inject(PUSH_PROVIDER) private readonly push: PushProvider,
    private readonly realtime: RealtimeEmitter,
  ) {}

  onModuleInit(): void {
    this.queue.registerWorker('notifications', async (job) => {
      const data = job.data as {
        userId: string;
        title: string;
        body: string;
        data?: Record<string, string>;
        notificationId: string;
      };
      const tokens = await this.prisma.deviceToken.findMany({
        where: { userId: data.userId },
      });
      const result = await this.push.send(
        tokens.map((t) => t.token),
        { title: data.title, body: data.body, data: data.data },
      );
      await this.prisma.appNotification.update({
        where: { id: data.notificationId },
        data: { status: result.successCount > 0 ? 'SENT' : 'FAILED' },
      });
      if (result.failedTokens.length > 0) {
        await this.prisma.deviceToken.deleteMany({
          where: { token: { in: result.failedTokens } },
        });
      }
    });
  }

  async registerDevice(userId: string, token: string, platform: string) {
    return this.prisma.deviceToken.upsert({
      where: { token },
      update: { userId, platform },
      create: { userId, token, platform },
    });
  }

  async removeDevice(userId: string, token: string): Promise<void> {
    await this.prisma.deviceToken.deleteMany({ where: { userId, token } });
  }

  async list(userId: string) {
    return this.prisma.appNotification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async notifyUser(
    userId: string,
    input: {
      type: string;
      title: string;
      body: string;
      data?: Record<string, string>;
    },
  ) {
    const notification = await this.prisma.appNotification.create({
      data: {
        userId,
        type: input.type,
        title: input.title,
        body: input.body,
        data: input.data,
      },
    });
    await this.queue.enqueue(this.queue.notifications, 'push', {
      userId,
      title: input.title,
      body: input.body,
      data: input.data,
      notificationId: notification.id,
    });
    this.realtime.emitToUser(userId, 'notification.received', {
      id: notification.id,
      type: notification.type,
      title: notification.title,
      body: notification.body,
      data: notification.data,
      createdAt: notification.createdAt,
    });
    return notification;
  }

  async markRead(userId: string, notificationId: string) {
    await this.prisma.appNotification.updateMany({
      where: { id: notificationId, userId },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }

  async markAllRead(userId: string) {
    await this.prisma.appNotification.updateMany({
      where: { userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
}
