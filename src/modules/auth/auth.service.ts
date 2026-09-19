import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomInt, randomUUID } from 'node:crypto';
import {
  hmacSha256,
  randomToken,
  sha256,
  timingSafeEqualHex,
} from '../../common/crypto/hashing';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { maskPhone, normalizePhoneE164 } from '../../common/phone/phone.util';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service';
import { AppConfigService } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import {
  OTP_DELIVERY_PROVIDER,
  type OtpDeliveryProvider,
} from '../../providers/otp/otp-delivery-provider';

type StoredOtp = {
  hash: string;
  attempts: number;
};

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
    private readonly rateLimit: RateLimitService,
    @Inject(OTP_DELIVERY_PROVIDER)
    private readonly otpDelivery: OtpDeliveryProvider,
  ) {}

  /** Legacy email registration — kept for admin/seed/e2e; not the product login path. */
  async register(email: string, password: string, displayName: string) {
    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const created = await tx.user.create({
          data: {
            email: email.toLowerCase(),
            passwordHash,
          },
        });
        await tx.profile.create({
          data: { userId: created.id, displayName },
        });
        await tx.wallet.create({
          data: { userId: created.id },
        });
        return created;
      });
      this.logger.log({ userId: user.id }, 'auth.register');
      return this.issueSession(user.id, user.role);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        throw new AppError(
          ErrorCodes.CONFLICT,
          'Email already registered',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /** Legacy email/password login — kept for admin tooling and e2e. */
  async login(email: string, password: string, clientIp = 'unknown') {
    await this.rateLimit.assertAllowed({
      key: `gmatez:ratelimit:login:ip:${clientIp}`,
      limit: 30,
      windowSeconds: 3600,
      code: ErrorCodes.RATE_LIMITED,
      message: 'Too many login attempts. Please try again later.',
    });

    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user) {
      throw new AppError(
        ErrorCodes.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) {
      throw new AppError(
        ErrorCodes.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertAccountEligible(user.status);
    this.logger.log({ userId: user.id }, 'auth.login');
    return this.issueSession(user.id, user.role);
  }

  async refresh(refreshToken: string) {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });

    if (!stored) {
      throw new AppError(
        ErrorCodes.AUTH_INVALID_SESSION,
        'Invalid refresh token',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (stored.revokedAt) {
      // True reuse vs concurrent refresh race:
      // the loser of an in-flight rotation may observe the claimed token as
      // already revoked. Only wipe the family after a short grace window.
      const graceMs = 15_000;
      const revokedAgeMs = Date.now() - stored.revokedAt.getTime();
      if (revokedAgeMs >= graceMs) {
        await this.prisma.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        this.logger.warn(
          { familyId: stored.familyId, userId: stored.userId },
          'auth.refresh_reuse_detected',
        );
      } else {
        this.logger.warn(
          { familyId: stored.familyId, userId: stored.userId },
          'auth.refresh_race',
        );
      }
      throw new AppError(
        ErrorCodes.AUTH_REFRESH_REUSED,
        'Session revoked. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    if (stored.expiresAt < new Date()) {
      await this.prisma.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });
      throw new AppError(
        ErrorCodes.AUTH_INVALID_SESSION,
        'Session expired. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    this.assertAccountEligible(stored.user.status);

    // Atomic claim — concurrent refresh with the same token yields one winner.
    const claimed = await this.prisma.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (claimed.count !== 1) {
      // Lost the race to another in-flight refresh — do NOT revoke the winner's family.
      throw new AppError(
        ErrorCodes.AUTH_REFRESH_REUSED,
        'Session revoked. Please sign in again.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    this.logger.log({ userId: stored.userId }, 'auth.refresh');
    return this.issueSession(stored.user.id, stored.user.role, stored.familyId);
  }

  async logout(refreshToken: string): Promise<void> {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    if (!stored) {
      return;
    }
    await this.prisma.refreshToken.updateMany({
      where: { familyId: stored.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    this.logger.log({ userId: stored.userId }, 'auth.logout');
  }

  /**
   * Legacy email OTP — not the product path. Kept for compatibility.
   * Responses avoid revealing whether the email is registered until verify.
   */
  async requestOtp(email: string): Promise<{ expiresInSeconds: number }> {
    const ttl = this.config.get('OTP_TTL_SECONDS');
    const otp = this.generateOtp();
    const hash = hmacSha256(this.config.get('OTP_PEPPER'), otp);
    await this.redis.client.set(
      `gmatez:otp:email:${email.toLowerCase()}`,
      JSON.stringify({ hash, attempts: 0 } satisfies StoredOtp),
      'EX',
      ttl,
    );
    const exposeOtp =
      this.config.allowsMockProviders && process.env.OTP_EXPOSE !== 'false';
    return exposeOtp
      ? ({ expiresInSeconds: ttl, otp } as {
          expiresInSeconds: number;
          otp?: string;
        })
      : { expiresInSeconds: ttl };
  }

  async verifyOtp(email: string, otp: string) {
    const key = `gmatez:otp:email:${email.toLowerCase()}`;
    const stored = await this.readStoredOtp(key);
    if (!stored) {
      throw new AppError(
        ErrorCodes.OTP_EXPIRED,
        'Code expired. Request a new one.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const hash = hmacSha256(this.config.get('OTP_PEPPER'), otp.trim());
    if (!timingSafeEqualHex(stored.hash, hash)) {
      throw new AppError(
        ErrorCodes.OTP_INVALID,
        'Invalid or expired OTP',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.redis.client.del(key);
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase() },
    });
    if (!user) {
      throw new AppError(
        ErrorCodes.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }
    this.assertAccountEligible(user.status);
    return this.issueSession(user.id, user.role);
  }

  /**
   * Product auth path: phone OTP request.
   * Always returns the same shape (enumeration-safe).
   */
  async requestPhoneOtp(
    phoneInput: string,
    clientIp = 'unknown',
  ): Promise<{
    expiresInSeconds: number;
    resendAvailableInSeconds: number;
  }> {
    const phone = this.normalizePhone(phoneInput);
    const ttl = this.config.get('OTP_TTL_SECONDS');
    const cooldown = this.config.get('OTP_RESEND_COOLDOWN_SECONDS');

    await this.rateLimit.assertAllowed({
      key: `gmatez:ratelimit:otp:ip:${clientIp}:send`,
      limit: this.config.get('OTP_MAX_SENDS_PER_IP_WINDOW'),
      windowSeconds: this.config.get('OTP_SEND_WINDOW_SECONDS'),
      code: ErrorCodes.OTP_RATE_LIMITED,
      message: 'Please try again later.',
    });
    await this.rateLimit.assertAllowed({
      key: `gmatez:ratelimit:otp:phone:${phone}:send`,
      limit: this.config.get('OTP_MAX_SENDS_PER_WINDOW'),
      windowSeconds: this.config.get('OTP_SEND_WINDOW_SECONDS'),
      code: ErrorCodes.OTP_RATE_LIMITED,
      message: 'Please try again later.',
    });

    const cooldownKey = `gmatez:otp:cooldown:${phone}`;
    const cooled = await this.rateLimit.setNxEx(cooldownKey, '1', cooldown);
    if (!cooled) {
      const retryAfterSeconds = await this.rateLimit.getTtlSeconds(cooldownKey);
      throw new AppError(
        ErrorCodes.OTP_RESEND_COOLDOWN,
        'Please wait before requesting another code.',
        HttpStatus.TOO_MANY_REQUESTS,
        { retryAfterSeconds: retryAfterSeconds || cooldown },
      );
    }

    const otp = this.resolveOutboundOtp();
    const hash = hmacSha256(this.config.get('OTP_PEPPER'), otp);
    const payload: StoredOtp = { hash, attempts: 0 };
    await this.redis.client.set(
      `gmatez:otp:phone:${phone}`,
      JSON.stringify(payload),
      'EX',
      ttl,
    );

    try {
      await this.otpDelivery.sendOtp({ phoneE164: phone, otp });
    } catch (error) {
      await this.redis.client.del(`gmatez:otp:phone:${phone}`);
      await this.redis.client.del(cooldownKey);
      throw error;
    }

    this.logger.log(
      { phone: maskPhone(phone), provider: this.otpDelivery.name },
      'otp.requested',
    );

    return {
      expiresInSeconds: ttl,
      resendAvailableInSeconds: cooldown,
    };
  }

  async verifyPhoneOtp(phoneInput: string, otp: string, clientIp = 'unknown') {
    const phone = this.normalizePhone(phoneInput);

    await this.rateLimit.assertAllowed({
      key: `gmatez:ratelimit:otp:ip:${clientIp}:verify`,
      limit: this.config.get('OTP_MAX_VERIFY_PER_WINDOW'),
      windowSeconds: this.config.get('OTP_VERIFY_WINDOW_SECONDS'),
      code: ErrorCodes.OTP_RATE_LIMITED,
      message: 'Please try again later.',
    });
    await this.rateLimit.assertAllowed({
      key: `gmatez:ratelimit:otp:phone:${phone}:verify`,
      limit: this.config.get('OTP_MAX_VERIFY_PER_WINDOW'),
      windowSeconds: this.config.get('OTP_VERIFY_WINDOW_SECONDS'),
      code: ErrorCodes.OTP_RATE_LIMITED,
      message: 'Please try again later.',
    });

    const key = `gmatez:otp:phone:${phone}`;
    const stored = await this.readStoredOtp(key);
    if (!stored) {
      throw new AppError(
        ErrorCodes.OTP_EXPIRED,
        'Code expired. Request a new one.',
        HttpStatus.UNAUTHORIZED,
      );
    }

    const maxAttempts = this.config.get('OTP_MAX_ATTEMPTS');
    if (stored.attempts >= maxAttempts) {
      await this.redis.client.del(key);
      throw new AppError(
        ErrorCodes.OTP_TOO_MANY_ATTEMPTS,
        'Too many incorrect codes. Request a new one.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const hash = hmacSha256(this.config.get('OTP_PEPPER'), otp.trim());
    if (!timingSafeEqualHex(stored.hash, hash)) {
      const nextAttempts = stored.attempts + 1;
      const ttl = await this.redis.client.ttl(key);
      if (nextAttempts >= maxAttempts) {
        await this.redis.client.del(key);
        throw new AppError(
          ErrorCodes.OTP_TOO_MANY_ATTEMPTS,
          'Too many incorrect codes. Request a new one.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      await this.redis.client.set(
        key,
        JSON.stringify({
          hash: stored.hash,
          attempts: nextAttempts,
        } satisfies StoredOtp),
        'EX',
        ttl > 0 ? ttl : this.config.get('OTP_TTL_SECONDS'),
      );
      throw new AppError(
        ErrorCodes.OTP_INVALID,
        'Invalid or expired OTP',
        HttpStatus.UNAUTHORIZED,
      );
    }

    // One-time use
    await this.redis.client.del(key);
    await this.redis.client.del(`gmatez:otp:cooldown:${phone}`);

    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      this.assertAccountEligible(existing.status);
      this.logger.log({ userId: existing.id }, 'otp.verified');
      return this.issueSession(existing.id, existing.role);
    }

    try {
      const passwordHash = await argon2.hash(randomToken(24), {
        type: argon2.argon2id,
      });
      const digits = phone.replace(/\D/g, '');
      const user = await this.prisma.user.create({
        data: {
          email: `p${digits}@phone.gmatez.invalid`,
          phone,
          passwordHash,
          profile: {
            create: { displayName: `User ${digits.slice(-4)}` },
          },
          wallet: { create: {} },
        },
      });
      this.logger.log({ userId: user.id }, 'otp.verified');
      return this.issueSession(user.id, user.role);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'P2002') {
        // Concurrent first-time verify — load winner and continue.
        const raced = await this.prisma.user.findUnique({ where: { phone } });
        if (raced) {
          this.assertAccountEligible(raced.status);
          return this.issueSession(raced.id, raced.role);
        }
      }
      throw error;
    }
  }

  private assertAccountEligible(status: UserStatus): void {
    if (status === UserStatus.SUSPENDED) {
      throw new AppError(
        ErrorCodes.ACCOUNT_SUSPENDED,
        'Account is suspended',
        HttpStatus.FORBIDDEN,
      );
    }
    if (status === UserStatus.DELETED) {
      throw new AppError(
        ErrorCodes.ACCOUNT_DELETED,
        'Account is unavailable',
        HttpStatus.UNAUTHORIZED,
      );
    }
    if (status !== UserStatus.ACTIVE) {
      throw new AppError(
        ErrorCodes.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }
  }

  private normalizePhone(input: string): string {
    return normalizePhoneE164(
      input,
      this.config.get('SUPPORTED_PHONE_REGIONS'),
      this.config.get('DEFAULT_PHONE_REGION'),
    );
  }

  private generateOtp(): string {
    const length = this.config.get('OTP_LENGTH');
    const min = 10 ** (length - 1);
    const max = 10 ** length;
    return String(randomInt(min, max));
  }

  private resolveOutboundOtp(): string {
    if (
      this.config.get('OTP_PROVIDER') === 'mock' &&
      this.config.allowsMockProviders
    ) {
      const length = this.config.get('OTP_LENGTH');
      const configured = this.config.get('MOCK_OTP')?.trim();
      if (configured && new RegExp(`^\\d{${length}}$`).test(configured)) {
        return configured;
      }
      if (length === 6) {
        return '123456';
      }
    }
    return this.generateOtp();
  }

  private async readStoredOtp(key: string): Promise<StoredOtp | null> {
    const raw = await this.redis.client.get(key);
    if (!raw) {
      return null;
    }
    try {
      // Backward compatible: plain hash string from older keys
      if (!raw.startsWith('{')) {
        return { hash: raw, attempts: 0 };
      }
      const parsed = JSON.parse(raw) as StoredOtp;
      if (!parsed.hash) {
        return null;
      }
      return { hash: parsed.hash, attempts: parsed.attempts ?? 0 };
    } catch {
      return null;
    }
  }

  private async issueSession(
    userId: string,
    role: 'USER' | 'ADMIN',
    familyId: string = randomUUID(),
  ) {
    const accessToken = await this.jwt.signAsync(
      { sub: userId, role, typ: 'access' },
      {
        secret: this.config.get('JWT_ACCESS_SECRET'),
        expiresIn: Math.floor(
          parseDurationMs(this.config.get('JWT_ACCESS_TTL')) / 1000,
        ),
      },
    );
    const refreshToken = randomToken(32);
    const ttl = this.config.get('JWT_REFRESH_TTL');
    const expiresAt = new Date(Date.now() + parseDurationMs(ttl));
    await this.prisma.refreshToken.create({
      data: {
        userId,
        familyId,
        tokenHash: sha256(refreshToken),
        expiresAt,
      },
    });
    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.config.get('JWT_ACCESS_TTL'),
    };
  }
}

function parseDurationMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  if (!match) {
    return 30 * 24 * 60 * 60 * 1000;
  }
  const value = Number(match[1]);
  const unit = match[2];
  const multipliers: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return value * multipliers[unit];
}
