import {
  activateHost,
  closeApp,
  createTestApp,
  me,
  prisma,
  registerAdmin,
  registerUser,
  resetDatabase,
} from './helpers';
import { NestFastifyApplication } from '@nestjs/platform-fastify';

describe('host lifecycle (e2e)', () => {
  let app: NestFastifyApplication;

  beforeEach(async () => {
    await resetDatabase();
    app = await createTestApp();
  });

  afterEach(async () => {
    await closeApp(app);
  });

  async function adminSession() {
    return registerAdmin(app);
  }

  const agreements = [
    { agreementType: 'HOST_GUIDELINES', version: '1.0' },
    { agreementType: 'TERMS_OF_SERVICE', version: '1.0' },
    { agreementType: 'PRIVACY_POLICY', version: '1.0' },
  ];

  it('rejects activation when host is incomplete', async () => {
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const bobUser = await me(app, bob.accessToken);
    const admin = await adminSession();

    const apply = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/applications',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: {
        applicationBio: 'Ready to listen carefully every day.',
        languages: ['en'],
        interests: ['chat'],
        voiceEnabled: true,
        videoEnabled: true,
        voiceRatePerMinuteCents: 150,
        videoRatePerMinuteCents: 250,
        acceptedAgreements: agreements,
      },
    });
    expect(apply.statusCode).toBe(201);

    const approve = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/hosts/${bobUser.id}/status`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { status: 'ACTIVE' },
    });
    expect(approve.statusCode).toBe(409);
    const body = JSON.parse(approve.body) as {
      error: { code: string; details?: { missingFields?: string[] } };
    };
    expect(body.error.code).toBe('HOST_INCOMPLETE');
    expect(body.error.details?.missingFields).toContain('avatar');
  });

  it('activates complete host and exposes completeness', async () => {
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const bobUser = await me(app, bob.accessToken);
    const admin = await adminSession();

    await activateHost({
      app,
      hostToken: bob.accessToken,
      adminToken: admin.accessToken,
      hostUserId: bobUser.id,
      online: false,
    });

    const completeness = await app.inject({
      method: 'GET',
      url: '/api/v1/hosts/me/completeness',
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(completeness.statusCode).toBe(200);
    expect(JSON.parse(completeness.body).isComplete).toBe(true);

    const online = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/me/availability',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { availability: 'ONLINE' },
    });
    expect(online.statusCode).toBe(201);

    const paused = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/me/availability',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { availability: 'PAUSED' },
    });
    expect(paused.statusCode).toBe(201);
    expect(JSON.parse(paused.body).availability).toBe('PAUSED');

    const profile = await prisma.profile.findUnique({
      where: { userId: bobUser.id },
    });
    expect(profile?.isDiscoverable).toBe(false);
  });

  it('rejects duplicate pending application', async () => {
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { avatarUrl: 'https://cdn.example.com/a.png' },
    });
    const payload = {
      applicationBio: 'Ready to listen carefully every day.',
      languages: ['en'],
      interests: ['chat'],
      acceptedAgreements: agreements,
    };
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/applications',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload,
    });
    expect(first.statusCode).toBe(201);
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/applications',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload,
    });
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).error.code).toBe('HOST_APPLICATION_EXISTS');
  });

  it('rejects call when host goes offline after discovery', async () => {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const bobUser = await me(app, bob.accessToken);
    const admin = await adminSession();

    await activateHost({
      app,
      hostToken: bob.accessToken,
      adminToken: admin.accessToken,
      hostUserId: bobUser.id,
    });

    const feed = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/feed?limit=20',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(
      JSON.parse(feed.body).items.some(
        (item: { userId: string }) => item.userId === bobUser.id,
      ),
    ).toBe(true);

    await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/me/availability',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { availability: 'OFFLINE' },
    });

    const call = await app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { calleeId: bobUser.id, callType: 'VOICE' },
    });
    expect(call.statusCode).toBe(409);
    expect(JSON.parse(call.body).error.code).toBe('HOST_UNAVAILABLE');
  });

  it('rejects manual BUSY and USER cannot self-activate', async () => {
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const bobUser = await me(app, bob.accessToken);
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { avatarUrl: 'https://cdn.example.com/a.png' },
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/applications',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: {
        applicationBio: 'Ready to listen carefully every day.',
        languages: ['en'],
        interests: ['chat'],
        acceptedAgreements: agreements,
      },
    });

    const selfActivate = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/hosts/${bobUser.id}/status`,
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { status: 'ACTIVE' },
    });
    expect(selfActivate.statusCode).toBe(403);

    const busy = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/me/availability',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { availability: 'BUSY' },
    });
    expect(busy.statusCode).toBe(400);
  });
});
