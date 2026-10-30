import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

const CONNECT_MAX_ATTEMPTS = 5;
const CONNECT_BASE_DELAY_MS = 1000;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  // A transient DB blip during a deploy/restart previously crashed the
  // whole process on the very first failed connection attempt (confirmed
  // by chaos testing) — nothing retried, and the app never got far enough
  // to serve /health, so an outage lasting only as long as the blip still
  // required an external restart. Retrying with backoff absorbs that
  // instead; a genuinely sustained outage still exits after exhausting
  // attempts (~15s total), same as before, for an orchestrator's restart
  // policy to handle.
  async onModuleInit(): Promise<void> {
    for (let attempt = 1; attempt <= CONNECT_MAX_ATTEMPTS; attempt++) {
      try {
        await this.$connect();
        return;
      } catch (error) {
        if (attempt === CONNECT_MAX_ATTEMPTS) {
          this.logger.error(
            {
              attempt,
              err: error instanceof Error ? error.message : 'unknown',
            },
            'database.connect_failed',
          );
          throw error;
        }
        const delayMs = CONNECT_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.logger.warn(
          {
            attempt,
            maxAttempts: CONNECT_MAX_ATTEMPTS,
            retryInMs: delayMs,
            err: error instanceof Error ? error.message : 'unknown',
          },
          'database.connect_retry',
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
