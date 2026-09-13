import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import {
  hmacSha256,
  randomToken,
  sha256,
  timingSafeEqualHex,
} from '../../common/crypto/hashing';
import { AppError, ErrorCodes } from '../../common/errors/app-error';
import { AppConfigService } from '../../config/app-config';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';

const OTP_TTL_SECONDS = 300;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: AppConfigService,
    private readonly redis: RedisService,
  ) {}

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
      this.logger.log({ userId: user.id }, 'user registered');
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

  async login(email: string, password: string) {
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
    if (user.status === UserStatus.SUSPENDED) {
      throw new AppError(
        ErrorCodes.USER_SUSPENDED,
        'Account is suspended',
        HttpStatus.FORBIDDEN,
      );
    }
    if (user.status === UserStatus.DELETED) {
      throw new AppError(
        ErrorCodes.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.issueSession(user.id, user.role);
  }

  async refresh(refreshToken: string) {
    const tokenHash = sha256(refreshToken);
    const stored = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
      include: { user: true },
    });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      if (stored?.revokedAt) {
        await this.prisma.refreshToken.updateMany({
          where: { familyId: stored.familyId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
      }
      throw new AppError(
        ErrorCodes.REFRESH_TOKEN_INVALID,
        'Invalid refresh token',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.prisma.refreshToken.update({
      where: { id: stored.id },
      data: { revokedAt: new Date() },
    });
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
  }

  async requestOtp(email: string): Promise<{ expiresInSeconds: number }> {
    const otp = String(Math.floor(100000 + Math.random() * 900000));
    const hash = hmacSha256(this.config.get('OTP_PEPPER'), otp);
    await this.redis.client.set(
      `otp:login:${email.toLowerCase()}`,
      hash,
      'EX',
      OTP_TTL_SECONDS,
    );
    if (!this.config.isProduction) {
      this.logger.log({ email, otpPreview: '******' }, 'otp issued');
    }
    // In development the OTP is returned so local clients can complete the flow
    // without an SMS provider. Production adapters send SMS/email instead.
    const exposeOtp =
      !this.config.isProduction && process.env.OTP_EXPOSE !== 'false';
    return exposeOtp
      ? ({ expiresInSeconds: OTP_TTL_SECONDS, otp } as {
          expiresInSeconds: number;
          otp?: string;
        })
      : { expiresInSeconds: OTP_TTL_SECONDS };
  }

  async verifyOtp(email: string, otp: string) {
    const key = `otp:login:${email.toLowerCase()}`;
    const stored = await this.redis.client.get(key);
    if (!stored) {
      throw new AppError(
        ErrorCodes.OTP_INVALID,
        'Invalid or expired OTP',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const hash = hmacSha256(this.config.get('OTP_PEPPER'), otp);
    if (!timingSafeEqualHex(stored, hash)) {
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
    if (!user || user.status !== UserStatus.ACTIVE) {
      throw new AppError(
        ErrorCodes.INVALID_CREDENTIALS,
        'Invalid credentials',
        HttpStatus.UNAUTHORIZED,
      );
    }
    return this.issueSession(user.id, user.role);
  }

  async requestPhoneOtp(phoneInput: string): Promise<{ expiresInSeconds: number }> {
    const phone = normalizePhone(phoneInput);
    const otp = this.demoOtp() ?? randomOtp();
    const hash = hmacSha256(this.config.get('OTP_PEPPER'), otp);
    await this.redis.client.set(
      `otp:phone:${phone}`,
      hash,
      'EX',
      OTP_TTL_SECONDS,
    );
    this.logger.log({ phone: maskPhone(phone) }, 'phone otp issued');
    return { expiresInSeconds: OTP_TTL_SECONDS };
  }

  async verifyPhoneOtp(phoneInput: string, otp: string) {
    const phone = normalizePhone(phoneInput);
    const key = `otp:phone:${phone}`;
    const stored = await this.redis.client.get(key);
    const hash = hmacSha256(this.config.get('OTP_PEPPER'), otp.trim());
    if (!stored || !timingSafeEqualHex(stored, hash)) {
      throw new AppError(
        ErrorCodes.OTP_INVALID,
        'Invalid or expired OTP',
        HttpStatus.UNAUTHORIZED,
      );
    }
    await this.redis.client.del(key);

    const existing = await this.prisma.user.findUnique({ where: { phone } });
    if (existing) {
      if (existing.status === UserStatus.SUSPENDED) {
        throw new AppError(
          ErrorCodes.USER_SUSPENDED,
          'Account is suspended',
          HttpStatus.FORBIDDEN,
        );
      }
      if (existing.status !== UserStatus.ACTIVE) {
        throw new AppError(
          ErrorCodes.INVALID_CREDENTIALS,
          'Invalid credentials',
          HttpStatus.UNAUTHORIZED,
        );
      }
      return this.issueSession(existing.id, existing.role);
    }

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
    this.logger.log({ userId: user.id }, 'phone user created');
    return this.issueSession(user.id, user.role);
  }

  private demoOtp(): string | null {
    const configured = process.env.MOCK_OTP?.trim();
    if (configured && /^\d{6}$/.test(configured)) {
      return configured;
    }
    if (process.env.ALLOW_MOCK_PROVIDERS === 'true') {
      return '123456';
    }
    return null;
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

function randomOtp(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

function normalizePhone(input: string): string {
  const compact = input.replace(/[\s()-]/g, '');
  const phone = compact.startsWith('+')
    ? `+${compact.slice(1).replace(/\D/g, '')}`
    : compact.replace(/\D/g, '');
  const withCountry = phone.startsWith('+')
    ? phone
    : phone.length === 10
      ? `+91${phone}`
      : phone.startsWith('91') && phone.length === 12
        ? `+${phone}`
        : '';
  if (!/^\+[1-9]\d{7,14}$/.test(withCountry)) {
    throw new AppError(
      ErrorCodes.VALIDATION_FAILED,
      'Enter a valid phone number',
      HttpStatus.BAD_REQUEST,
    );
  }
  return withCountry;
}

function maskPhone(phone: string): string {
  return `${phone.slice(0, 3)}******${phone.slice(-2)}`;
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
