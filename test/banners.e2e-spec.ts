import { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  closeApp,
  createTestApp,
  me,
  promoteAdmin,
  registerUser,
  resetDatabase,
} from './helpers';

describe('Promo banners (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    await resetDatabase();
    app = await createTestApp();
  });

  afterAll(async () => {
    await closeApp(app);
  });

  it('lists active banners for users and supports admin CRUD', async () => {
    const user = await registerUser(
      app,
      'banner-user@example.com',
      'Banner User',
    );
    const adminReg = await registerUser(
      app,
      'banner-admin@example.com',
      'Banner Admin',
    );
    const adminMe = await me(app, adminReg.accessToken);
    await promoteAdmin(adminMe.id);

    const createAll = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/banners',
      headers: { authorization: `Bearer ${adminReg.accessToken}` },
      payload: {
        title: 'Wallet boost',
        subtitle: 'Top up today',
        ctaLabel: 'Open Wallet',
        deepLink: '/wallet',
        audience: 'ALL',
        priority: 50,
        isActive: true,
      },
    });
    expect(createAll.statusCode).toBe(201);

    const createHost = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/banners',
      headers: { authorization: `Bearer ${adminReg.accessToken}` },
      payload: {
        title: 'Host only tip',
        subtitle: 'For listeners',
        deepLink: '/host/dashboard',
        audience: 'HOST',
        priority: 5,
        isActive: true,
      },
    });
    expect(createHost.statusCode).toBe(201);
    const created = JSON.parse(createHost.body) as { id: string };

    const listUser = await app.inject({
      method: 'GET',
      url: '/api/v1/banners',
      headers: { authorization: `Bearer ${user.accessToken}` },
    });
    expect(listUser.statusCode).toBe(200);
    const userBanners = JSON.parse(listUser.body) as Array<{
      title: string;
      audience: string;
    }>;
    expect(userBanners.some((b) => b.title === 'Wallet boost')).toBe(true);
    expect(userBanners.every((b) => b.audience !== 'HOST')).toBe(true);

    const adminList = await app.inject({
      method: 'GET',
      url: '/api/v1/admin/banners',
      headers: { authorization: `Bearer ${adminReg.accessToken}` },
    });
    expect(adminList.statusCode).toBe(200);
    expect(JSON.parse(adminList.body).length).toBeGreaterThanOrEqual(2);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/api/v1/admin/banners/${created.id}`,
      headers: { authorization: `Bearer ${adminReg.accessToken}` },
      payload: { isActive: false },
    });
    expect(patch.statusCode).toBe(200);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/admin/banners/${created.id}`,
      headers: { authorization: `Bearer ${adminReg.accessToken}` },
    });
    expect(del.statusCode).toBe(200);
  });

  it('rejects non-admin banner writes', async () => {
    const user = await registerUser(app, 'banner-plain@example.com', 'Plain');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/banners',
      headers: { authorization: `Bearer ${user.accessToken}` },
      payload: { title: 'Nope' },
    });
    expect(res.statusCode).toBe(403);
  });
});
