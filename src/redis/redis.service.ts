import { Injectable, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config';

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: AppConfigService) {
    this.client = new Redis(config.get('REDIS_URL'), {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async onlineUserIds(userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) {
      return new Set();
    }
    const pipeline = this.client.pipeline();
    for (const id of userIds) {
      pipeline.exists(`presence:${id}`);
    }
    const results = await pipeline.exec();
    const online = new Set<string>();
    results?.forEach((result, index) => {
      if (result && result[1] === 1) {
        online.add(userIds[index]);
      }
    });
    return online;
  }
}
