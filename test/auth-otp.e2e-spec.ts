import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { sha256 } from '../src/common/crypto/hashing';
import { RedisService } from '../src/redis/redis.service';
import {
  closeApp,
  createTestApp,
  me,
  prisma,
  promoteAdmin,
  registerUser,
  resetDatabase,
} from './helpers';

describe('phone OTP auth (e2e)', () => {
  let app: NestFastifyApplication;
  let redis: RedisService;

  beforeAll(async () => {
    app = await createTestApp();
    redis = app.get(RedisService);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function clearRedisOtp(phone: string) {
    const e164 = phone.startsWith('+') ? phone : `+91${phone}`;
    const keys = [
      `gmatez:otp:phone:${e164}`,
      `gmatez:otp:cooldown:${e164}`,
      `gmatez:ratelimit:otp:phone:${e164}:send`,
      `gmatez:ratelimit:otp:phone:${e164}:verify`,
      `gmatez:ratelimit:otp:ip:127.0.0.1:send`,
      `gmatez:ratelimit:otp:ip:127.0.0.1:verify`,
    ];
    for (const key of keys) {
      await redis.client.del(key);
    }
  }

  it('registers via phone OTP, refreshes, and revokes on logout', async () => {
    const phone = '+919900001111';
    await clearRedisOtp(phone);

    const request = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      payload: { phone },
    });
    expect(request.statusCode).toBe(200);
    const challenge = JSON.parse(request.body) as {
      expiresInSeconds: number;
      resendAvailableInSeconds: number;
    };
    expect(challenge.expiresInSeconds).toBeGreaterThan(0);
    expect(challenge.resendAvailableInSeconds).toBeGreaterThan(0);

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      payload: { phone, otp: '123456' },
    });
    expect(verify.statusCode).toBe(200);
    const session = JSON.parse(verify.body) as {
      accessToken: string;
      refreshToken: string;
    };

    await me(app, session.accessToken);

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
    const rotated = JSON.parse(refresh.body) as {
      accessToken: string;
      refreshToken: string;
    };

    const reuse = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(reuse.statusCode).toBe(401);
    expect(JSON.parse(reuse.body).error.code).toBe('AUTH_REFRESH_REUSED');

    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      payload: { refreshToken: rotated.refreshToken },
    });
    const afterLogout = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: rotated.refreshToken },
    });
    expect(afterLogout.statusCode).toBe(401);
  });

  it('rejects invalid OTP and enforces attempt limit', async () => {
    const phone = '+919900002222';
    await clearRedisOtp(phone);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      payload: { phone },
    });

    let lastCode = '';
    for (let i = 0; i < 5; i += 1) {
      const bad = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/phone/otp/verify',
        payload: { phone, otp: '000000' },
      });
      lastCode = JSON.parse(bad.body).error.code as string;
      expect([401, 429]).toContain(bad.statusCode);
    }
    expect(['OTP_INVALID', 'OTP_TOO_MANY_ATTEMPTS']).toContain(lastCode);

    const after = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      payload: { phone, otp: '123456' },
    });
    expect([401, 429]).toContain(after.statusCode);
  });

  it('enforces resend cooldown', async () => {
    const phone = '+919900003333';
    await clearRedisOtp(phone);
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      payload: { phone },
    });
    expect(first.statusCode).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      payload: { phone },
    });
    expect(second.statusCode).toBe(429);
    expect(JSON.parse(second.body).error.code).toBe('OTP_RESEND_COOLDOWN');
    expect(
      JSON.parse(second.body).error.details.retryAfterSeconds,
    ).toBeGreaterThan(0);
  });

  it('rejects suspended account on protected API', async () => {
    const phone = '+919900004444';
    await clearRedisOtp(phone);
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      payload: { phone },
    });
    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      payload: { phone, otp: '123456' },
    });
    const session = JSON.parse(verify.body) as { accessToken: string };
    const user = await me(app, session.accessToken);

    const adminReg = await registerUser(app, 'admin-otp@example.com', 'Admin');
    const adminUser = await me(app, adminReg.accessToken);
    await promoteAdmin(adminUser.id);

    const suspend = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/users/${user.id}/status`,
      headers: { authorization: `Bearer ${adminReg.accessToken}` },
      payload: { status: 'SUSPENDED' },
    });
    expect(suspend.statusCode).toBe(200);
    const suspended = await prisma.user.findUnique({ where: { id: user.id } });
    expect(suspended?.status).toBe('SUSPENDED');

    const wallet = await app.inject({
      method: 'GET',
      url: '/api/v1/wallet',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(wallet.statusCode).toBe(403);
    expect(JSON.parse(wallet.body).error.code).toBe('ACCOUNT_SUSPENDED');
  });

  it('handles concurrent refresh without dual active tokens', async () => {
    const alice = await registerUser(app, 'refresh-race@example.com', 'Alice');
    const [a, b] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: alice.refreshToken },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/auth/refresh',
        payload: { refreshToken: alice.refreshToken },
      }),
    ]);
    const statuses = [a.statusCode, b.statusCode].sort();
    expect(statuses).toEqual([200, 401]);
    const winner = a.statusCode === 200 ? a : b;
    const body = JSON.parse(winner.body) as { refreshToken: string };
    const userId = (
      await prisma.refreshToken.findFirst({
        where: { tokenHash: sha256(body.refreshToken) },
      })
    )?.userId;
    expect(userId).toBeTruthy();
    const active = await prisma.refreshToken.findMany({
      where: { userId: userId!, revokedAt: null },
    });
    expect(active).toHaveLength(1);
    expect(active[0].tokenHash).toBe(sha256(body.refreshToken));
  });
});
