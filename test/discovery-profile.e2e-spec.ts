import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  activateHost,
  closeApp,
  createTestApp,
  me,
  registerAdmin,
  registerUser,
  resetDatabase,
} from './helpers';

describe('discovery and profiles (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  async function adminSession() {
    return registerAdmin(app);
  }

  it('rejects unauthenticated profile and discovery access', async () => {
    const profile = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/me',
    });
    const feed = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/feed',
    });
    expect(profile.statusCode).toBe(401);
    expect(feed.statusCode).toBe(401);
  });

  it('returns the current user profile without secrets', async () => {
    const session = await registerUser(app, 'alice@example.com', 'Alice');
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as Record<string, unknown>;
    expect(body.displayName).toBe('Alice');
    expect(body.passwordHash).toBeUndefined();
    expect(body.accessToken).toBeUndefined();
    expect(body.refreshToken).toBeUndefined();
    expect(body.email).toBeUndefined();
    expect(typeof body.availableForCall).toBe('boolean');
  });

  it('updates a valid profile and rejects invalid fields', async () => {
    const session = await registerUser(app, 'alice@example.com', 'Alice');
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: {
        displayName: 'Alice Updated',
        bio: 'Hello there',
        language: 'en',
        country: 'US',
        avatarUrl: 'https://example.com/alice.png',
      },
    });
    expect(ok.statusCode).toBe(200);
    expect(JSON.parse(ok.body).displayName).toBe('Alice Updated');

    const shortName = await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { displayName: 'A' },
    });
    expect(shortName.statusCode).toBe(400);

    const longBio = await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { bio: 'x'.repeat(281) },
    });
    expect(longBio.statusCode).toBe(400);

    const badAvatar = await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${session.accessToken}` },
      payload: { avatarUrl: 'javascript:alert(1)' },
    });
    expect(badAvatar.statusCode).toBe(400);
  });

  it('returns 404 for a missing public profile and invalid ids', async () => {
    const session = await registerUser(app, 'alice@example.com', 'Alice');
    const missing = await app.inject({
      method: 'GET',
      url: '/api/v1/users/00000000-0000-4000-8000-000000000099',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(missing.statusCode).toBe(404);

    const invalid = await app.inject({
      method: 'GET',
      url: '/api/v1/users/not-a-uuid',
      headers: { authorization: `Bearer ${session.accessToken}` },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('does not allow editing another user profile', async () => {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${alice.accessToken}` },
      payload: { displayName: 'Still Alice' },
    });
    const bobProfile = await app.inject({
      method: 'GET',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${bob.accessToken}` },
    });
    expect(bobProfile.statusCode).toBe(200);
    expect(JSON.parse(bobProfile.body).displayName).toBe('Bob');
  });

  it('lists ACTIVE discoverable hosts only and paginates', async () => {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const carol = await registerUser(app, 'carol@example.com', 'Carol');
    const dave = await registerUser(app, 'dave@example.com', 'Dave');
    const admin = await adminSession();

    const bobUser = await me(app, bob.accessToken);
    const carolUser = await me(app, carol.accessToken);
    const daveUser = await me(app, dave.accessToken);

    await activateHost({
      app,
      hostToken: bob.accessToken,
      adminToken: admin.accessToken,
      hostUserId: bobUser.id,
      languages: ['en'],
    });
    await activateHost({
      app,
      hostToken: carol.accessToken,
      adminToken: admin.accessToken,
      hostUserId: carolUser.id,
      languages: ['es'],
    });
    await activateHost({
      app,
      hostToken: dave.accessToken,
      adminToken: admin.accessToken,
      hostUserId: daveUser.id,
      languages: ['en'],
    });

    // Carol hides from discovery while remaining ACTIVE (PAUSED ≠ discoverable).
    await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/me/availability',
      headers: { authorization: `Bearer ${carol.accessToken}` },
      payload: { availability: 'PAUSED' },
    });

    const feed = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/feed?limit=20',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(feed.statusCode).toBe(200);
    const body = JSON.parse(feed.body) as {
      items: Array<{ userId: string; displayName: string }>;
      nextCursor: string | null;
    };
    const names = body.items.map((item) => item.displayName);
    expect(names).toContain('Bob');
    expect(names).toContain('Dave');
    expect(names).not.toContain('Alice');
    expect(names).not.toContain('Carol');
    expect(names).not.toContain('Admin');

    const page1 = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/feed?limit=1',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    const first = JSON.parse(page1.body) as {
      items: Array<{ userId: string }>;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(1);
    expect(first.nextCursor).toBeTruthy();
    const page2 = await app.inject({
      method: 'GET',
      url: `/api/v1/discovery/feed?limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(JSON.parse(page2.body).items[0].userId).not.toBe(
      first.items[0].userId,
    );

    const search = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/search?q=Bob',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(JSON.parse(search.body).items).toHaveLength(1);

    const empty = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/search?q=zzzzzz',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(JSON.parse(empty.body).items).toEqual([]);

    const language = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/feed?language=en',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    const langItems = JSON.parse(language.body).items as Array<{
      displayName: string;
    }>;
    expect(langItems.length).toBeGreaterThan(0);
    expect(langItems.every((item) => item.displayName !== 'Carol')).toBe(true);

    const publicProfile = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${bobUser.id}`,
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(publicProfile.statusCode).toBe(200);
    expect(JSON.parse(publicProfile.body).profile.displayName).toBe('Bob');

    const badLimit = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/feed?limit=0',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    expect(badLimit.statusCode).toBe(400);
  });

  it('excludes SUSPENDED hosts from discovery', async () => {
    const alice = await registerUser(app, 'alice@example.com', 'Alice');
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    const admin = await adminSession();
    const bobUser = await me(app, bob.accessToken);

    await activateHost({
      app,
      hostToken: bob.accessToken,
      adminToken: admin.accessToken,
      hostUserId: bobUser.id,
    });

    const suspend = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/hosts/${bobUser.id}/status`,
      headers: { authorization: `Bearer ${admin.accessToken}` },
      payload: { status: 'SUSPENDED' },
    });
    expect(suspend.statusCode).toBe(200);

    const feed = await app.inject({
      method: 'GET',
      url: '/api/v1/discovery/feed?limit=20',
      headers: { authorization: `Bearer ${alice.accessToken}` },
    });
    const names = (
      JSON.parse(feed.body) as { items: Array<{ displayName: string }> }
    ).items.map((i) => i.displayName);
    expect(names).not.toContain('Bob');
  });

  it('accepts flat host apply rates contract', async () => {
    const bob = await registerUser(app, 'bob@example.com', 'Bob');
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { avatarUrl: 'https://cdn.example.com/avatars/bob.png' },
    });
    const apply = await app.inject({
      method: 'POST',
      url: '/api/v1/hosts/applications',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: {
        applicationBio: 'Ready to listen carefully every day.',
        languages: ['en'],
        interests: ['chat'],
        voiceEnabled: true,
        videoEnabled: false,
        voiceRatePerMinuteCents: 200,
        videoRatePerMinuteCents: 300,
        acceptedAgreements: [
          { agreementType: 'HOST_GUIDELINES', version: '1.0' },
          { agreementType: 'TERMS_OF_SERVICE', version: '1.0' },
          { agreementType: 'PRIVACY_POLICY', version: '1.0' },
        ],
      },
    });
    expect(apply.statusCode).toBe(201);
    const body = JSON.parse(apply.body) as {
      status: string;
      voiceRatePerMinuteCents: number;
      videoRatePerMinuteCents: number;
    };
    expect(body.status).toBe('PENDING_REVIEW');
    expect(body.voiceRatePerMinuteCents).toBe(200);
    expect(body.videoRatePerMinuteCents).toBe(300);
  });
});
