import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';
import { AppConfigService } from '../config/app-config';

@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  readonly client: Redis;

  constructor(config: AppConfigService) {
    this.client = new Redis(config.get('REDIS_URL'), {
      // null, not a number: once maxRetriesPerRequest is reached, ioredis
      // flushes every queued command's promise with MaxRetriesPerRequestError
      // — including its own internal ready-check command, which nothing
      // in this codebase awaits/catches, so that rejection goes unhandled
      // and crashes the whole process. Confirmed by chaos testing: a
      // finite retry count here crashed the backend even with the
      // 'error' listener below already attached. null means ioredis
      // retries forever in the background instead of ever giving up and
      // rejecting in-flight commands — the same setting already used for
      // this app's BullMQ connections in queue.service.ts, for the same
      // reason. A command issued while Redis is down will hang rather
      // than fail fast, which is the right trade: one slow request beats
      // bringing down every other request on the process.
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
    });
    // ioredis emits 'error' on every connection hiccup (not just a full
    // outage). With no listener attached, Node treats that as an uncaught
    // exception and kills the whole process — confirmed by chaos testing:
    // a single unreachable Redis crashed the entire backend, not just
    // Redis-dependent features.
    this.client.on('error', (err) => {
      this.logger.error({ err: err.message }, 'redis.connection_error');
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
