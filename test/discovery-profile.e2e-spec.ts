import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { closeApp, createTestApp, prisma, resetDatabase } from './helpers';

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

  async function register(email: string, displayName: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/register',
      payload: { email, password: 'ChangeMe123!', displayName },
    });
    expect(res.statusCode).toBe(201);
    return JSON.parse(res.body) as { accessToken: string };
  }

  async function me(token: string) {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.body) as { id: string; email: string };
  }

  it('rejects unauthenticated profile and discovery access', async () => {
    const profile = await app.inject({ method: 'GET', url: '/api/v1/profiles/me' });
    const feed = await app.inject({ method: 'GET', url: '/api/v1/discovery/feed' });
    expect(profile.statusCode).toBe(401);
    expect(feed.statusCode).toBe(401);
  });

  it('returns the current user profile without secrets', async () => {
    const session = await register('alice@example.com', 'Alice');
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
    const session = await register('alice@example.com', 'Alice');
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
    const session = await register('alice@example.com', 'Alice');
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
    const alice = await register('alice@example.com', 'Alice');
    const bob = await register('bob@example.com', 'Bob');
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

  it('lists discoverable users, excludes self and hidden users, and paginates', async () => {
    const alice = await register('alice@example.com', 'Alice');
    const bob = await register('bob@example.com', 'Bob');
    const carol = await register('carol@example.com', 'Carol');
    await register('dave@example.com', 'Dave');
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${carol.accessToken}` },
      payload: { isDiscoverable: false, language: 'es' },
    });
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/profiles/me',
      headers: { authorization: `Bearer ${bob.accessToken}` },
      payload: { language: 'en', bio: 'Bob bio' },
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
    expect(names).not.toContain('Alice');
    expect(names).not.toContain('Carol');

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
    expect(JSON.parse(page2.body).items[0].userId).not.toBe(first.items[0].userId);

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
    expect(
      JSON.parse(language.body).items.length,
    ).toBeGreaterThan(0);
    expect(
      JSON.parse(language.body).items.every(
        (item: { language: string }) => item.language === 'en',
      ),
    ).toBe(true);

    const publicProfile = await app.inject({
      method: 'GET',
      url: `/api/v1/users/${(await me(bob.accessToken)).id}`,
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
});
