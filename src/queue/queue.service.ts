import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker, JobsOptions, Processor } from 'bullmq';
import { AppConfigService } from '../config/app-config';

export const QUEUE_NAMES = {
  notifications: 'notifications',
  callLifecycle: 'call-lifecycle',
} as const;

@Injectable()
export class QueueService implements OnModuleDestroy {
  readonly notifications: Queue;
  readonly callLifecycle: Queue;
  private readonly workers: Worker[] = [];
  private readonly connectionUrl: string;

  constructor(config: AppConfigService) {
    this.connectionUrl = config.get('REDIS_URL');
    const connection = {
      url: this.connectionUrl,
      maxRetriesPerRequest: null,
    };
    this.notifications = new Queue(QUEUE_NAMES.notifications, {
      connection,
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
      },
    });
    this.callLifecycle = new Queue(QUEUE_NAMES.callLifecycle, {
      connection,
      defaultJobOptions: {
        removeOnComplete: 1000,
        removeOnFail: 5000,
        attempts: 3,
        backoff: { type: 'exponential', delay: 500 },
      },
    });
  }

  registerWorker(name: string, processor: Processor, concurrency = 5): Worker {
    const worker = new Worker(name, processor, {
      connection: {
        url: this.connectionUrl,
        maxRetriesPerRequest: null,
      },
      concurrency,
    });
    this.workers.push(worker);
    return worker;
  }

  async enqueue(
    queue: Queue,
    name: string,
    data: unknown,
    opts?: JobsOptions,
  ): Promise<void> {
    await queue.add(name, data, opts);
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.close()));
    await Promise.all([this.notifications.close(), this.callLifecycle.close()]);
  }
}
