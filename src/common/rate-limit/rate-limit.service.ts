import { Injectable } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { HttpStatus } from '@nestjs/common';

@Injectable()
export class RateLimitService {
  constructor(private readonly redis: RedisService) {}

  /**
   * Increment a namespaced counter. Returns remaining TTL as retry-after when limited.
   */
  async consume(input: {
    key: string;
    limit: number;
    windowSeconds: number;
    code?: string;
    message?: string;
  }): Promise<
    { allowed: true } | { allowed: false; retryAfterSeconds: number }
  > {
    const key = input.key;
    const count = await this.redis.client.incr(key);
    if (count === 1) {
      await this.redis.client.expire(key, input.windowSeconds);
    }
    if (count > input.limit) {
      const ttl = await this.redis.client.ttl(key);
      return {
        allowed: false,
        retryAfterSeconds: ttl > 0 ? ttl : input.windowSeconds,
      };
    }
    return { allowed: true };
  }

  async assertAllowed(input: {
    key: string;
    limit: number;
    windowSeconds: number;
    code?: string;
    message?: string;
  }): Promise<void> {
    const result = await this.consume(input);
    if (!result.allowed) {
      throw new AppError(
        input.code ?? ErrorCodes.OTP_RATE_LIMITED,
        input.message ?? 'Please try again later.',
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: result.retryAfterSeconds },
      );
    }
  }

  async getTtlSeconds(key: string): Promise<number> {
    const ttl = await this.redis.client.ttl(key);
    return ttl > 0 ? ttl : 0;
  }

  async setNxEx(
    key: string,
    value: string,
    ttlSeconds: number,
  ): Promise<boolean> {
    const result = await this.redis.client.set(
      key,
      value,
      'EX',
      ttlSeconds,
      'NX',
    );
    return result === 'OK';
  }
}
