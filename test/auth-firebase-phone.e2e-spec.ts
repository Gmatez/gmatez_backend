import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { RedisService } from '../src/redis/redis.service';
import { closeApp, createTestApp, me, resetDatabase } from './helpers';

describe('Firebase phone auth (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
    // RedisService is resolved to confirm it's wired for rate-limit keys below.
    app.get(RedisService);
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  it('registers via a Firebase phone token, refreshes, and logs out', async () => {
    // The mock PHONE_IDENTITY_VERIFIER (PHONE_AUTH_PROVIDER=mock in test env)
    // treats the "token" string as the already-verified E.164 phone number.
    const phone = '+919900005555';

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/firebase/verify',
      payload: { idToken: phone },
    });
    expect(verify.statusCode).toBe(200);
    const session = JSON.parse(verify.body) as {
      accessToken: string;
      refreshToken: string;
    };

    const user = await me(app, session.accessToken);
    expect(user.id).toBeTruthy();

    const refresh = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/refresh',
      payload: { refreshToken: session.refreshToken },
    });
    expect(refresh.statusCode).toBe(200);
    const rotated = JSON.parse(refresh.body) as { refreshToken: string };

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

  it('logs an existing phone user back in rather than re-registering', async () => {
    const phone = '+919900006666';

    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/firebase/verify',
      payload: { idToken: phone },
    });
    const firstUser = await me(
      app,
      (JSON.parse(first.body) as { accessToken: string }).accessToken,
    );

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/firebase/verify',
      payload: { idToken: phone },
    });
    expect(second.statusCode).toBe(200);
    const secondUser = await me(
      app,
      (JSON.parse(second.body) as { accessToken: string }).accessToken,
    );

    expect(secondUser.id).toBe(firstUser.id);
  });

  it('rejects a malformed/invalid token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/firebase/verify',
      payload: { idToken: 'not-a-valid-firebase-token-at-all' },
    });
    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body).error.code).toBe('PHONE_TOKEN_INVALID');
  });

  it('keeps the deprecated phone-OTP routes functional', async () => {
    const phone = '+919900007777';
    const request = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/request',
      payload: { phone },
    });
    expect(request.statusCode).toBe(200);

    const verify = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/phone/otp/verify',
      payload: { phone, otp: '123456' },
    });
    expect(verify.statusCode).toBe(200);
  });
});
